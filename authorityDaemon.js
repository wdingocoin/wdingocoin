const express = require('express');
const database = require('./database.js');
const dingo = require('./dingo');
const smartContract = require('./smartContract.js');
const cors = require('cors');
const crypto = require('crypto');
const fs = require('fs');
const axios = require('axios');
const rateLimit = require("express-rate-limit");
const ipfilter = require('express-ipfilter').IpFilter

function isSpecified(x) {
  return x !== undefined && x !== null;
}

function createSignedMessage(data) {
  return {
    data: data,
    signature: smartContract.sign(JSON.stringify(data)).signature
  };
}

function validateSignedMessageStructure(message) {
  if (!isSpecified(message)) {
    throw new Error('Message not specified');
  }
  if (isSpecified(message.error)) {
    throw new Error(message.error);
  }
  if (!isSpecified(message.data)) {
    throw new Error('Message missing data');
  }
  if (!isSpecified(message.signature) || typeof message.signature !== 'string') {
    throw new Error('Message missing signature');
  }
}

function validateSignedMessage(message, walletAddress, discard=true) {
  validateSignedMessageStructure(message);
  if (!smartContract.verify(JSON.stringify(message.data), message.signature, walletAddress)) {
    throw new Error('Authority verification failed');
  }
  if (discard) {
    return message.data;
  } else {
    return message;
  }
}

function validateSignedMessageOne(message, walletAddresses, discard=true) {
  validateSignedMessageStructure(message);
  const verifications = walletAddresses.map(
    x => smartContract.verify(JSON.stringify(message.data), message.signature, x) ? 1 : 0);
  if (verifications.reduce((a, b) => a + b, 0) !== 1) {
    throw new Error('Authority verification failed');
  }
  if (discard) {
    return message.data;
  } else {
    return message;
  }
}

(async function main() {

  dingo.walletPassphrase(' ');

  const args = process.argv.slice(2);
  const settingsFolder = args[0];
  const databaseSettings = JSON.parse(fs.readFileSync(`${settingsFolder}/database.json`));
  const smartContractSettings = JSON.parse(fs.readFileSync(`${settingsFolder}/smartContract.json`));
  const publicSettings = JSON.parse(fs.readFileSync(`${settingsFolder}/public.json`));
  const privateSettings = JSON.parse(fs.readFileSync(`${settingsFolder}/private.DO_NOT_SHARE_THIS.json`));
  const dingoSettings = JSON.parse(fs.readFileSync(`${settingsFolder}/dingo.json`));

  smartContract.loadProvider(smartContractSettings.provider);
  smartContract.loadContract(smartContractSettings.contractAbi, smartContractSettings.contractAddress);
  smartContract.loadAccount(privateSettings.walletPrivateKey);
  database.load(databaseSettings.databasePath);

  const app = express();
  app.use(cors());
  app.use(express.json());

  app.post('/generateDepositAddress', rateLimit({ windowMs: 60 * 1000, max: 1 }), async (req, res) => {
    const data = req.body;
    const mintAddress = data.mintAddress;
    if (!smartContract.isAddress(mintAddress)) {
      throw new Error('mintAddress missing or invalid');
    }

    res.send(createSignedMessage({
      mintAddress: data.mintAddress,
      depositAddress: await dingo.getNewAddress()
    }));
  });

  app.post('/registerMintDepositAddress', async (req, res) => {
    const data = req.body;
    if (data.generateDepositAddressResponses.length !== publicSettings.authorityNodes.length) {
      throw new Error('Incorrect authority count');
    }
    const generateDepositAddressResponses = data.generateDepositAddressResponses.map(
      (x, i) => validateSignedMessage(x, publicSettings.authorityNodes[i].walletAddress)
    );
    if (!generateDepositAddressResponses.every((x) => x.mintAddress === generateDepositAddressResponses[0].mintAddress)) {
      throw new Error('Consensus failure on mint address');
    }
    const mintAddress = generateDepositAddressResponses[0].mintAddress;
    if (!smartContract.isAddress(mintAddress)) {
      throw new Error('mintAddress missing or invalid');
    }

    const multisigDepositAddress = await database.acquire(async () => {
      // Validate against previously used addresses in database.
      const depositAddresses = generateDepositAddressResponses.map((x) => x.depositAddress);
      if (await database.hasUsedDepositAddresses(depositAddresses)) {
        throw new Error('At least one deposit address has been previously registered');
      }

      // Register as previously used.
      await database.registerUsedDepositAddresses(depositAddresses);

      // Compute multisigDepositAddress.
      const multisigDepositAddress = await dingo.addMultisigAddress(
        publicSettings.authorityThreshold, depositAddresses
      );

      // Register mintDepositAddress.
      await database.registerMintDepositAddress(mintAddress, multisigDepositAddress);

      return multisigDepositAddress;
    });

    res.send(createSignedMessage({
      depositAddress: multisigDepositAddress
    }));
  });

  app.post('/queryMintBalance', async (req, res) => {
    const data = req.body;
    const mintAddress = data.mintAddress;
    if (!smartContract.isAddress(mintAddress)) {
      throw new Error('mintAddress missing or invalid');
    }

    // Retrieve deposit address.
    const depositAddress = await database.acquire(() => database.getMintDepositAddress(mintAddress));

    if (depositAddress === null) {
      res.send(createSignedMessage(null));
    } else {
      // Retrieve deposited amount.
      const depositedAmount = await dingo.getReceivedAmountByAddress(depositAddress);
      const depositedAmountAfterTax = (BigInt(depositedAmount) - BigInt(depositedAmount) / 100n).toString()

      // Retrieve minted amount.
      const {mintNonce, mintedAmount} = await smartContract.getMintHistory(mintAddress, depositAddress);

      res.send(createSignedMessage({
        mintNonce: mintNonce.toString(),
        mintAddress: mintAddress,
        depositAddress: depositAddress,
        depositedAmount: depositedAmountAfterTax.toString(),
        mintedAmount: mintedAmount.toString()
      }));
    }
  });

  app.post('/createMintTransaction', async (req, res) => {
    const data = req.body;
    const mintAddress = data.mintAddress;
    if (!smartContract.isAddress(mintAddress)) {
      throw new Error('mintAddress missing or invalid');
    }

    // Retrieve deposit address.
    const depositAddress = await database.acquire(() => database.getMintDepositAddress(mintAddress));

    // Retrieve deposited amount.
    const depositedAmount = await dingo.getReceivedAmountByAddress(depositAddress);
    const depositedAmountAfterTax = (BigInt(depositedAmount) - BigInt(depositedAmount) / 100n).toString()

    // Retrieve minted amount.
    const {mintNonce, mintedAmount} = await smartContract.getMintHistory(mintAddress, depositAddress);

    const mintAmount = (BigInt(depositedAmountAfterTax) - BigInt(mintedAmount)).toString();

    const signature = smartContract.signMintTransaction(mintAddress, mintNonce, depositAddress, mintAmount);

    res.send(createSignedMessage({
      mintAddress: mintAddress,
      mintNonce: mintNonce,
      depositAddress: depositAddress,
      mintAmount: mintAmount,
      onContractVerification: {
        v: signature.v,
        r: signature.r,
        s: signature.s
      }
    }));
  });

  app.post('/queryBurnHistory', async (req, res) => {
    const data = req.body;
    const burnAddress = data.burnAddress;
    if (!smartContract.isAddress(burnAddress)) {
      throw new Error('burnAddress missing or invalid');
    }

    const burnHistory = await smartContract.getBurnHistory(burnAddress);

    await database.acquire(async () => {
      for (const i in burnHistory) {
        burnHistory[i].approved = await database.hasApprovedWithdrawal(burnAddress, i);
      }
    });

    res.send(createSignedMessage({
      burnHistory: burnHistory
    }));
  });

  app.post('/approveWithdrawal', async (req, res) => {
    const data = req.body;
    const burnAddress = data.burnAddress;
    const burnIndex = data.burnIndex;
    let approvalChain = data.approvalChain;
    if (!smartContract.isAddress(burnAddress)) {
      throw new Error('burnAddress missing or invalid');
    }

    await database.acquire(async () => {
      if (await database.hasApprovedWithdrawal(burnAddress, burnIndex)) {
        throw new Error('Withdrawal already approved');
      }

      const { burnDestination, burnAmount } = await smartContract.getBurnHistory(burnAddress, burnIndex);

      // Compute unspent.
      const received = await dingo.listReceivedByAddress();
      const registeredMintDepositAddresses = (await database.getRegisteredMintDepositAddresses()).map((x) => x.depositAddress);
      const nonEmptyMintDepositAddresses = registeredMintDepositAddresses.filter((x) => x in received);
      const unspent = await dingo.listUnspent(nonEmptyMintDepositAddresses, dingoSettings.changeAddress);

      // Create raw transaction if not exists.
      if (approvalChain === null || approvalChain === undefined || approvalChain === '') {
        const transactionHex = await dingo.createRawTransaction(
          unspent, dingoSettings.changeAddress, burnDestination, burnAmount, dingoSettings.fee,
          { burnAddress: burnAddress, burnIndex: burnIndex });
        approvalChain = transactionHex;
      }

      // Verify.
      if (!dingo.verifyRawTransaction(
        unspent, dingoSettings.changeAddress, burnDestination, burnAmount, dingoSettings.fee,
        { burnAddress: burnAddress, burnIndex: burnIndex }, approvalChain)) {
        throw new Error('Consensus failure on withdrawal details');
      }

      // Register and approve.
      await database.registerApprovedWithdrawal(burnAddress, burnIndex);
      const signedTransactionHex = (await dingo.signRawTransaction(approvalChain)).hex;

      res.send(createSignedMessage({
        approvalChain: signedTransactionHex
      }));
    });
  });

  app.post('/executeWithdrawal', async (req, res) => {
    const data = req.body;
    const approvalChain = data.approvalChain;

    await dingo.sendRawTranscation(approvalChain);

    res.send(createSignedMessage({

    }));
  });

  const computeStats = async () => {

    // Read from database.
    const registeredMintDepositAddresses = await database.getRegisteredMintDepositAddresses();
    const registeredApprovedWithdrawals = await database.getRegisteredApprovedWithdrawals();
    const registeredPayoutRequests = await database.getRegisteredPayoutRequests('approved');

    // Fetch deposited by addresses.
    const deposited = await dingo.getReceivedAmountByAddresses(registeredMintDepositAddresses.map((x) => x.depositAddress));
    // Compute deposit statistics.
    const totalDepositedAmount = registeredMintDepositAddresses.reduce((a, b) => a + BigInt(deposited[b.depositAddress]), 0n);
    const totalDepositedTaxAmount = registeredMintDepositAddresses.reduce((a, b) => a + BigInt(deposited[b.depositAddress]) / 100n, 0n);
    const totalDepositedMintableAmount = totalDepositedAmount - totalDepositedTaxAmount;

    // Fetch burned by addresses and indexes.
    const { burnDestinations, burnAmounts } = await smartContract.getBurnHistoryMultiple(
      registeredApprovedWithdrawals.map((x) => x.burnAddress),
      registeredApprovedWithdrawals.map((x) => x.burnIndex)
    );
    // Compute withdraw statistics.
    const totalWithdrawnAmount = burnAmounts.reduce((a, b) => a + BigInt(b), 0n);
    const totalWithdrawnTaxAmount = burnAmounts.reduce((a, b) => a + BigInt(b) / 100n, 0n);
    const totalWithdrawnFinalAmount = totalWithdrawnAmount - totalWithdrawnTaxAmount;

    // Compute unspent.
    const received = await dingo.listReceivedByAddress();
    const nonEmptyMintDepositAddresses = registeredMintDepositAddresses.filter((x) => x in received);
    const unspent = await dingo.listUnspent(nonEmptyMintDepositAddresses, dingoSettings.changeAddress);
    const totalUnspent = unspent.reduce((a, b) => a + BigInt(dingo.toSatoshi(b.amount.toString())), BigInt(0));

    const totalExpectedUnspent = totalDepositedAmount - totalWithdrawnFinalAmount;

    return {
      totalDepositedAmount: totalDepositedAmount,
      totalDepositedTaxAmount: totalDepositedTaxAmount,
      totalDepositedMintableAmount: totalDepositedMintableAmount,
      totalWithdrawnAmount: totalWithdrawnAmount,
      totalWithdrawnTaxAmount: totalWithdrawnTaxAmount,
      totalWithdrawnFinalAmount: totalWithdrawnFinalAmount,
      totalUnspent: totalUnspent,
      totalExpectedUnspent: totalExpectedUnspent
    }

  };

  app.post('/requestPayout', ipfilter(['127.0.0.1']), async (req, res) => {
    // Compute unspent.
    const received = await dingo.listReceivedByAddress();
    const registeredMintDepositAddresses = (await database.getRegisteredMintDepositAddresses()).map((x) => x.depositAddress);
    const nonEmptyMintDepositAddresses = registeredMintDepositAddresses.filter((x) => x in received);
    const unspent = await dingo.listUnspent(nonEmptyMintDepositAddresses, dingoSettings.changeAddress);

    // Create raw transaction.
    const raw = await dingo.createPayoutRawTransaction(
        unspent, dingoSettings.changeAddress, dingoSettings.payoutAddresses,
        '10000000000', dingoSettings.fee);
    console.log(await dingo.decodeRawTranscation(raw));
  });

  app.post('/approvePayout',
    ipfilter(publicSettings.authorityNodes.map((x) => x.location).concat(['127.0.0.1'])),
    async (req, res) => {
      const data = req.body;
      const amount = data.amount;
      const stats = await computeStats();


    }
  );

  app.post('/stats', rateLimit({ windowMs: 1000, max: 1 }), async (req, res) => {
    const s = await computeStats();

    console.log('==================================');
    console.log('Total deposited (coins): ' + dingo.fromSatoshi(s.totalDepositedAmount.toString()));
    console.log('Total tax from deposits (coins): ' + dingo.fromSatoshi(s.totalDepositedTaxAmount.toString()));
    console.log('Total mintable (tokens): ' + dingo.fromSatoshi(s.totalDepositedMintableAmount.toString()));
    console.log('-----');
    console.log('Total withdrawn (tokens): ' + dingo.fromSatoshi(s.totalWithdrawnAmount.toString()));
    console.log('Total tax from withdrawals (coins): ' + dingo.fromSatoshi(s.totalWithdrawnTaxAmount.toString()));
    console.log('Total withdrawn post-tax (coins): ' + dingo.fromSatoshi(s.totalWithdrawnFinalAmount.toString()));
    console.log('-----');
    console.log('Total unspent (coins): ' + dingo.fromSatoshi(s.totalUnspent.toString()));
    console.log('Total expected unspent (coins): ' + dingo.fromSatoshi(s.totalExpectedUnspent.toString()));
    console.log('==================================');
  });

  app.listen(publicSettings.port, () => {
    console.log(`Started on port ${publicSettings.port}`);
  });
})();

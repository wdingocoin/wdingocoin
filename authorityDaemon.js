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
const morgan = require('morgan');

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

function getAuthorityLink(x) {
  return `http://${x.location}:${x.port}`;
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
  //app.use(morgan('combined'));

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
      const depositedAmount = dingo.toSatoshi((await dingo.getReceivedAmountByAddress(dingoSettings.confirmations, depositAddress)).toString());
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
    const depositedAmount = dingo.toSatoshi((await dingo.getReceivedAmountByAddress(dingoSettings.confirmations, depositAddress)).toString());
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
        const w = await database.getWithdrawal(burnAddress, i);
        burnHistory[i].status = w === null ? null : w.approvedTax === "0" ? "SUBMITTED" : "APPROVED";
      }
    });

    res.send(createSignedMessage({
      burnHistory: burnHistory
    }));
  });

  app.post('/submitWithdrawal', async (req, res) => {
    const data = req.body;
    const burnAddress = data.burnAddress;
    const burnIndex = data.burnIndex;
    if (!smartContract.isAddress(burnAddress)) {
      throw new Error('burnAddress missing or invalid');
    }

    await database.acquire(async () => {
      if (await database.getWithdrawal(burnAddress, burnIndex) !== null) {
        throw new Error('Withdrawal already submitted');
      }

      const { burnDestination, burnAmount } = await smartContract.getBurnHistory(burnAddress, burnIndex);
      if (!(await dingo.verifyAddress(burnDestination))) {
        throw new Error('Withdrawal address is not a valid Dingo address');
      }
      if (burnAmount < BigInt(dingo.toSatoshi(dingoSettings.fee))) {
        throw new Error('Amount too little');
      }

      await database.registerWithdrawal(burnAddress, burnIndex);
      res.send(createSignedMessage({

      }));
    });
  });

  const computeStats = async () => {

    // Read from database.
    const registeredMintDepositAddresses = (await database.getRegisteredMintDepositAddresses()).map((x) => x.depositAddress);
    const registeredWithdrawals = await database.getRegisteredWithdrawals();

    // Fetch deposited by addresses.
    const deposited = await dingo.getReceivedAmountByAddresses(registeredMintDepositAddresses);
    // Compute deposit statistics.
    const totalDepositedAmount = registeredMintDepositAddresses.reduce((a, b) => a + BigInt(dingo.toSatoshi(deposited[b].toString())), 0n);
    const totalDepositedTaxAmount = registeredMintDepositAddresses.reduce((a, b) => a + BigInt(dingo.toSatoshi(deposited[b].toString())) / 100n, 0n);
    const totalDepositedMintableAmount = totalDepositedAmount - totalDepositedTaxAmount;

    // Fetch burned by addresses and indexes.
    const { burnDestinations, burnAmounts } = await smartContract.getBurnHistoryMultiple(
      registeredWithdrawals.map((x) => x.burnAddress),
      registeredWithdrawals.map((x) => x.burnIndex)
    );
    // Compute withdraw statistics.
    const totalWithdrawnAmount = burnAmounts.reduce((a, b) => a + BigInt(b), 0n);
    const totalWithdrawnTaxAmount = burnAmounts.reduce((a, b) => a + BigInt(b) / 100n, 0n);
    const totalWithdrawnFinalAmount = totalWithdrawnAmount - totalWithdrawnTaxAmount;

    // Compute expected unspent.
    const totalExpectedUnspent = totalDepositedAmount - totalWithdrawnFinalAmount;

    // Compute unspent.
    const received = await dingo.listReceivedByAddress(dingoSettings.confirmations);
    const nonEmptyMintDepositAddresses = registeredMintDepositAddresses.filter((x) => x in received);
    const unspent = await dingo.listUnspent(dingoSettings.confirmations, nonEmptyMintDepositAddresses, dingoSettings.changeAddress);
    const totalUnspent = unspent.reduce((a, b) => a + BigInt(dingo.toSatoshi(b.amount.toString())), BigInt(0));

    const totalTaxCollected = totalDepositedTaxAmount + totalWithdrawnTaxAmount;

    return {
      totalDepositedAmount: totalDepositedAmount,
      totalDepositedTaxAmount: totalDepositedTaxAmount,
      totalDepositedMintableAmount: totalDepositedMintableAmount,
      totalWithdrawnAmount: totalWithdrawnAmount,
      totalWithdrawnTaxAmount: totalWithdrawnTaxAmount,
      totalWithdrawnFinalAmount: totalWithdrawnFinalAmount,
      totalUnspent: totalUnspent,
      totalExpectedUnspent: totalExpectedUnspent,
      totalTaxCollected: totalTaxCollected
    }

  };

  const computeLatestPayouts = async () => {

    const fee = BigInt(dingo.toSatoshi(dingoSettings.fee));
    let totalTax = 0n;
    const depositTaxPayouts = {}; // Track which deposit taxes are being paid.
    const withdrawalPayouts = {}; // Track which withdrawals are being paid.
    const withdrawalTaxPayouts = {}; // Tack which withdrawal taxes are being paid.
    const payoutsByAddress = {}; // Final payouts by address.

    // Compute tax from deposits.
    const deposited = await dingo.listReceivedByAddress(dingoSettings.confirmations);
    const nonEmptyMintDepositAddresses = (await database.getRegisteredMintDepositAddresses(Object.keys(deposited)));
    for (const a of nonEmptyMintDepositAddresses) {
      const approvedTax = BigInt(dingo.toSatoshi(a.approvedTax));
      const depositedAmount = BigInt(dingo.toSatoshi(deposited[a.depositAddress].amount.toString()));
      const approvableTax = depositedAmount < fee ? 0 : fee + (depositedAmount - fee) / 100n;
      if (approvableTax > approvedTax) {
        const amount = approvableTax - approvedTax;
        totalTax += amount;
        depositTaxPayouts[a.depositAddress] = amount;
      } else if (approvableTax < approvedTax) {
        throw new Error('Deposit approved tax exceeds approvable');
      }
    }

    // Query unapproved withdrawals.
    const unapprovedWithdrawals = await database.getRegisteredUnapprovedWithdrawals();
    const burnAddresses = unapprovedWithdrawals.map((x) => x.burnAddress);
    const burnIndexes = unapprovedWithdrawals.map((x) => x.burnIndex);
    const { burnDestinations, burnAmounts } = await smartContract.getBurnHistoryMultiple(burnAddresses, burnIndexes);

    // Compute unapproved withdrawal payouts and tax from withdrawals.
    for (const i in burnDestinations) {
      const paid = BigInt(burnAmounts[i]) - fee - (BigInt(burnAmounts[i]) - fee) / 100n;
      const tax = BigInt(burnAmounts[i]) - paid;
      if (burnDestinations[i] in payoutsByAddress) {
        payoutsByAddress[burnDestinations[i]] += paid;
      } else {
        payoutsByAddress[burnDestinations[i]] = paid;
      }
      withdrawalPayouts[[burnAddresses[i], burnIndexes[i]]] = paid;
      totalTax += tax;
      withdrawalTaxPayouts[[burnAddresses[i], burnIndexes[i]]] = tax;
    }

    // Check if tax payout is at least fee.
    if (totalTax < fee) {
      throw new Error(`Total tax amount does not hit fees (${dingo.fromSatoshi(totalTax.toString())} / ${dingoSettings.fee})`);
    }

    // Compute tax payouts.
    const taxPayoutPerPayee = (totalTax - fee) / BigInt(dingoSettings.taxPayoutAddresses.length);
    for (const a of dingoSettings.taxPayoutAddresses) {
      if (a in payoutsByAddress) {
        payoutsByAddress[a] += taxPayoutPerPayee;
      } else {
        payoutsByAddress[a] = taxPayoutPerPayee;
      }
    }

    // Compute total payout.
    const totalPayout = Object.values(payoutsByAddress).reduce((a, b) => a + b, 0n);

    // Compute change.
    const unspent = await dingo.listUnspent(dingoSettings.confirmations, nonEmptyMintDepositAddresses.map((x) => x.depositAddress), dingoSettings.changeAddress);
    const totalUnspent = unspent.reduce((a, b) => a + BigInt(dingo.toSatoshi(b.amount.toString())), BigInt(0));
    const change = totalUnspent - totalPayout - fee; // Rounding errors from taxPayout / N is absorbed into change here.
    if (change < 0) {
      throw new Error('Insufficient funds');
    }
    if (dingoSettings.changeAddress in payoutsByAddress) {
      payoutsByAddress[dingoSettings.changeAddress] += change;
    } else {
      payoutsByAddress[dingoSettings.changeAddress] = change;
    }

    // Convert to string.
    for (const address of Object.keys(payoutsByAddress)) {
      payoutsByAddress[address] = dingo.fromSatoshi(payoutsByAddress[address].toString());
    }

    return { unspent: unspent, payoutsByAddress: payoutsByAddress };
  };

  app.post('/requestPayouts', ipfilter(['127.0.0.1']), async (req, res) => {
    const { unspent, payoutsByAddress } = await computeLatestPayouts();
    let approvalChain = await dingo.createRawTransaction(unspent, payoutsByAddress, {});
    approvalChain = await dingo.verifyAndSignRawTransaction(unspent, payoutsByAddress, {}, approvalChain);
    for (const node of publicSettings.authorityNodes) {
      if (node.walletAddress !== smartContract.getAccountAddress()) {
        approvalChain = validateSignedMessage(
          (await axios.post(`${getAuthorityLink(node)}/approvePayouts`, createSignedMessage({ approvalChain: approvalChain }))).data,
          node.walletAddress
        ).approvalChain;
      }
    }
  });

  app.post('/approvePayouts', ipfilter([publicSettings.authorityNodes[publicSettings.payoutCoordinator].location]), async (req, res) => {
    const data = validateSignedMessage(req.body, publicSettings.authorityNodes[publicSettings.payoutCoordinator].walletAddress);
    const { unspent, payoutsByAddress } = await computeLatestPayouts();
    const approvalChain = await dingo.verifyAndSignRawTransaction(unspent, payoutsByAddress, {}, data.approvalChain);
    res.send(createSignedMessage({ approvalChain: approvalChain }));
  });

  app.post('/stats', rateLimit({ windowMs: 1000, max: 1 }), async (req, res) => {
    const s = await computeStats();

    console.log('==================================');
    console.log('Total deposited (coins): ' + dingo.fromSatoshi(s.totalDepositedAmount.toString()));
    console.log('Total tax collected from deposits (coins): ' + dingo.fromSatoshi(s.totalDepositedTaxAmount.toString()));
    console.log('Total mintable (tokens): ' + dingo.fromSatoshi(s.totalDepositedMintableAmount.toString()));
    console.log('-----');
    console.log('(Mint and burn records are stored directly on the smart contract.)');
    console.log('-----');
    console.log('Total withdrawn (tokens): ' + dingo.fromSatoshi(s.totalWithdrawnAmount.toString()));
    console.log('Total tax collected from withdrawals (coins): ' + dingo.fromSatoshi(s.totalWithdrawnTaxAmount.toString()));
    console.log('Total withdrawn post-tax (coins): ' + dingo.fromSatoshi(s.totalWithdrawnFinalAmount.toString()));
    console.log('-----');
    console.log('Total unspent (coins): ' + dingo.fromSatoshi(s.totalUnspent.toString()));
    console.log('Total expected unspent (coins): ' + dingo.fromSatoshi(s.totalExpectedUnspent.toString()));
    console.log('Total tax collected (coins): ' + dingo.fromSatoshi(s.totalTaxCollected.toString()));
    console.log('==================================');
  });

  app.listen(publicSettings.port, () => {
    console.log(`Started on port ${publicSettings.port}`);
  });
})();

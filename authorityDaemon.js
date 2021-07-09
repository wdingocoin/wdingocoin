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

const LOCALHOST = '127.0.0.1';

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

  app.post('/ping', rateLimit({ windowMs: 10 * 1000, max: 10}), async (req, res) => {
    res.send(createSignedMessage({ timestamp: Date.now() }));
  });

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

  app.post('/registerMintDepositAddress', rateLimit({ windowMs: 60 * 1000, max: 1 }), async (req, res) => {
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

  app.post('/stats',
    rateLimit({ windowMs: 5 * 1000, max: 1 }),
    ipfilter(publicSettings.authorityNodes.map((x) => x.location).concat([LOCALHOST])),
    async (req, res) => {
      const fee = BigInt(dingo.toSatoshi(dingoSettings.fee));
      const stats = { depositAddresses: {}, withdrawals: {} };

      const depositAddresses = await database.getMintDepositAddresses();
      stats.depositAddresses.count = depositAddresses.length;
      stats.depositAddresses.totalApprovedTax = depositAddresses.reduce((a, b) => a + BigInt(b.approvedTax), 0n).toString();

      const withdrawals = await database.getWithdrawals();
      stats.withdrawals.count = withdrawals.length;
      stats.withdrawals.totalApprovedAmount = withdrawals.reduce((a, b) => a + BigInt(b.approvedAmount), 0n).toString();
      stats.withdrawals.totalApprovedTax = withdrawals.reduce((a, b) => a + BigInt(b.approvedTax), 0n).toString();

      res.send(createSignedMessage(stats));
    }
  );

  app.post('/allNodeStats', ipfilter([LOCALHOST]), async (req, res) => {
    const stats = await Promise.all(publicSettings.authorityNodes.map(
      async (x) => validateSignedMessage((await axios.post(`${getAuthorityLink(x)}/stats`)).data, x.walletAddress)));

    for (const i in publicSettings.authorityNodes) {
      console.log(`============= AUTHORITY ${i} ===============`);
      console.log('[NODE INFO]');
      console.log(`  Node IP: ${publicSettings.authorityNodes[i].location}`);
      console.log(`  Wallet: ${publicSettings.authorityNodes[i].walletAddress}`);
      console.log('[DEPOSITS]');
      console.log(`  Count: ${stats[i].depositAddresses.count}`);
      console.log(`  Total approved tax: ${dingo.fromSatoshi(stats[i].depositAddresses.totalApprovedTax)}`);
      console.log('[WITHDRAWALS]');
      console.log(`  Count: ${stats[i].withdrawals.count}`);
      console.log(`  Total approved amount: ${dingo.fromSatoshi(stats[i].withdrawals.totalApprovedAmount)}`);
      console.log(`  Total approved tax: ${dingo.fromSatoshi(stats[i].withdrawals.totalApprovedTax)}`);
      if (i == publicSettings.authorityNodes.length - 1) {
        console.log('============================================');
      }
    }
  });



  // Compute pending payouts:
  // 1) Tax payouts from deposits (10 + 1%).
  // 2) Withdrawal payouts.
  // 3) Tax payouts from withdrawals (10 + 1%).
  const computePendingPayouts = async () => {

    const fee = BigInt(dingo.toSatoshi(dingoSettings.fee));
    const depositTaxPayouts = []; // Track which deposit taxes are being paid.
    const withdrawalPayouts = []; // Track which withdrawals are being paid.
    const withdrawalTaxPayouts = []; // Track which withdrawal taxes are being paid.

    // Compute tax from deposits.
    const deposited = await dingo.listReceivedByAddress(dingoSettings.confirmations);
    const nonEmptyMintDepositAddresses = (await database.getMintDepositAddresses(Object.keys(deposited)));
    for (const a of nonEmptyMintDepositAddresses) {
      const approvedTax = BigInt(a.approvedTax);
      const depositedAmount = BigInt(dingo.toSatoshi(deposited[a.depositAddress].amount.toString()));
      const approvableTax = depositedAmount < fee ? 0 : fee + (depositedAmount - fee) / 100n;
      if (approvableTax > approvedTax) {
        const amount = approvableTax - approvedTax;
        depositTaxPayouts.push({ depositAddress: a.depositAddress, amount: amount.toString() });
      } else if (approvableTax < approvedTax) {
        throw new Error('Deposit approved tax exceeds approvable');
      }
    }

    // Query unapproved withdrawals.
    const unapprovedWithdrawals = await database.getUnapprovedWithdrawals();
    const burnAddresses = unapprovedWithdrawals.map((x) => x.burnAddress);
    const burnIndexes = unapprovedWithdrawals.map((x) => x.burnIndex);
    const { burnDestinations, burnAmounts } = await smartContract.getBurnHistoryMultiple(burnAddresses, burnIndexes);
    // Compute unapproved withdrawal payouts and tax from withdrawals.
    for (const i in burnDestinations) {
      const paid = BigInt(burnAmounts[i]) - fee - (BigInt(burnAmounts[i]) - fee) / 100n;
      const tax = BigInt(burnAmounts[i]) - paid;
      withdrawalPayouts.push({
        burnAddress: burnAddresses[i],
        burnIndex: burnIndexes[i],
        burnDestination: burnDestinations[i],
        amount: paid.toString() });
      withdrawalTaxPayouts.push({
        burnAddress: burnAddresses[i],
        burnIndex: burnIndexes[i],
        burnDestination: burnDestinations[i],
        amount: tax.toString() });
    }

    return {
      depositTaxPayouts: depositTaxPayouts,
      withdrawalPayouts: withdrawalPayouts,
      withdrawalTaxPayouts: withdrawalTaxPayouts
    };
  };

  const validatePayouts = async (depositTaxPayouts, withdrawalPayouts, withdrawalTaxPayouts) => {

    const fee = BigInt(dingo.toSatoshi(dingoSettings.fee));
    const totalTax = depositTaxPayouts.reduce((a, b) => a + BigInt(b.amount), 0n) + withdrawalTaxPayouts.reduce((a, b) => a + BigInt(b.amount), 0n);
    if (totalTax < fee) {
      throw new Error('Insufficient tax to cover fees');
    }

    // Check if requested tax from deposits does not exceed taxable.
    const deposited = await dingo.listReceivedByAddress(dingoSettings.confirmations);
    const depositAddresses = {};
    (await database.getMintDepositAddresses(Object.keys(deposited))).forEach((x) => depositAddresses[x.depositAddress] = x);

    for (const p of depositTaxPayouts) {
      if (!(p.depositAddress in deposited)) {
        throw new Error('Dingo address has zero balance');
      }
      if (!(p.depositAddress in depositAddresses)) {
        throw new Error('Dingo address not registered');
      }
      const approvedTax = BigInt(depositAddresses[p.depositAddress].approvedTax);
      const depositedAmount = BigInt(toSatoshi(deposited[p.depositAddress].amount.toString()));
      const approvableTax = depositedAmount < fee ? 0 : fee + (depositedAmount - fee) / 100n;
      if (BigInt(p.amount) > approvableTax) {
        throw new Error('Requested tax amount more than approvable tax');
      }
    }

    // Query unapproved withdrawals.
    if (withdrawalPayouts.length !== withdrawalTaxPayouts.length) {
      throw new Error('Withdrawal and withdrawal tax payouts mismatch in count');
    }
    // Compute unapproved withdrawal payouts and tax from withdrawals.
    for (const i in withdrawalPayouts) {
      const burnAddress = withdrawalPayouts[i].burnAddress;
      const burnIndex = withdrawalPayouts[i].burnIndex;
      if (burnAddress !== withdrawalTaxPayouts[i].burnAddress || burnIndex !== withdrawalTaxPayouts[i].burnIndex) {
        throw new Error('Mismatch in withdrawal and withdrawal tax payout details');
      }
      const withdrawal = await database.getWithdrawal(burnAddress, burnIndex);
      if (withdrawal === null) {
        throw new Error('Withdrawal not registered');
      }
      if (withdrawal.approvedAmount !== '0' || withdrawal.approvedTax !== '0') {
        throw new Error('Withdrawal already approved');
      }
      const { burnDestination, burnAmount } = await smartContract.getBurnHistory(burnAddress, burnIndex);
      if (withdrawalPayouts[i].burnDestination !== burnDestination) {
        throw new Error('Withdrawal destination incorrect');
      }
      if (withdrawalTaxPayouts[i].burnDestination !== burnDestination) {
        throw new Error('Withdrawal tax destination incorrect');
      }
      const paid = BigInt(burnAmount) - fee - (BigInt(burnAmount) - fee) / 100n;
      const tax = BigInt(burnAmount) - paid;
      if (BigInt(withdrawalPayouts[i].amount) !== paid) {
        throw new Error('Withdrawal amount incorrect');
      }
      if (BigInt(withdrawalTaxPayouts[i].amount) !== tax) {
        throw new Error('Withdrawal tax amount incorrect');
      }
    }

  };

  const computeUnspentAndVouts = async (depositTaxPayouts, withdrawalPayouts, withdrawalTaxPayouts) => {

    // Process withdrawal payouts.
    const vouts = {};
    for (const p of withdrawalPayouts) {
      if (p.burnDestination in vouts) {
        vouts[p.burnDestination] += BigInt(p.amount);
      } else {
        vouts[p.burnDestination] = BigInt(p.amount);
      }
    }

    // Compute tax payouts.
    const fee = BigInt(dingo.toSatoshi(dingoSettings.fee));
    const totalTax = depositTaxPayouts.reduce((a, b) => a + BigInt(b.amount), 0n) + withdrawalTaxPayouts.reduce((a, b) => a + BigInt(b.amount), 0n);
    const taxPayoutPerPayee = (totalTax - fee) / BigInt(dingoSettings.taxPayoutAddresses.length);
    for (const a of dingoSettings.taxPayoutAddresses) {
      if (a in vouts) {
        vouts[a] += taxPayoutPerPayee;
      } else {
        vouts[a] = taxPayoutPerPayee;
      }
    }

    // Compute total payout.
    const totalPayout = Object.values(vouts).reduce((a, b) => a + b, 0n);

    // Compute change.
    const deposited = await dingo.listReceivedByAddress(dingoSettings.confirmations);
    const nonEmptyMintDepositAddresses = (await database.getMintDepositAddresses(Object.keys(deposited)));
    const unspent = await dingo.listUnspent(dingoSettings.confirmations, nonEmptyMintDepositAddresses.map((x) => x.depositAddress), dingoSettings.changeAddress);
    const totalUnspent = unspent.reduce((a, b) => a + BigInt(dingo.toSatoshi(b.amount.toString())), BigInt(0));
    const change = totalUnspent - totalPayout - fee; // Rounding errors from taxPayout / N is absorbed into change here.
    if (change < 0) {
      throw new Error('Insufficient funds');
    }
    if (dingoSettings.changeAddress in vouts) {
      vouts[dingoSettings.changeAddress] += change;
    } else {
      vouts[dingoSettings.changeAddress] = change;
    }

    // Convert to string.
    for (const address of Object.keys(vouts)) {
      vouts[address] = dingo.fromSatoshi(vouts[address].toString());
    }

    return { unspent: unspent, vouts: vouts };
  };

  const applyPayouts = async (depositTaxPayouts, withdrawalPayouts, withdrawalTaxPayouts) => {
    const depositAddresses = {};
    (await database.getMintDepositAddresses(depositTaxPayouts.map((x) => x.depositAddress))).forEach((x) => depositAddresses[x.depositAddress] = x);
    for (const p of depositTaxPayouts) {
      const previousTax = BigInt(depositAddresses[p.depositAddress].approvedTax);
      const tax = BigInt(p.amount);
      depositAddresses[p.depositAddress].approvedTax = (previousTax + tax).toString();
    }
    await database.updateMintDepositAddresses(Object.values(depositAddresses));

    const withdrawals = [];
    for (const i in withdrawalPayouts) {
      const withdrawal = await database.getWithdrawal(withdrawalPayouts[i].burnAddress, withdrawalPayouts[i].burnIndex);
      const previousApprovedAmount = BigInt(withdrawal.approvedAmount);
      const previousApprovedTax = BigInt(withdrawal.approvedTax);
      const amount = BigInt(withdrawalPayouts[i].amount);
      const tax = BigInt(withdrawalTaxPayouts[i].amount);
      withdrawal.approvedAmount = (previousApprovedAmount + amount).toString();
      withdrawal.approvedTax = (previousApprovedTax + tax).toString();
      withdrawals.push(withdrawal);
    }
    await database.updateWithdrawals(withdrawals);
  };


  app.post('/requestPayouts', ipfilter([LOCALHOST]), async (req, res) => {
    const { depositTaxPayouts, withdrawalPayouts, withdrawalTaxPayouts } = await computePendingPayouts();
    const { unspent, vouts } = await computeUnspentAndVouts(depositTaxPayouts, withdrawalPayouts, withdrawalTaxPayouts);

    // Validate payouts.
    await validatePayouts(depositTaxPayouts, withdrawalPayouts, withdrawalTaxPayouts);

    // Compute approval chain and sign.
    let approvalChain = await dingo.createRawTransaction(
      unspent, vouts,
      {
        depositTaxPayouts: depositTaxPayouts,
        withdrawalPayouts: withdrawalPayouts,
        withdrawalTaxPayouts: withdrawalTaxPayouts
      });
    approvalChain = await dingo.verifyAndSignRawTransaction(
      unspent, vouts,
      {
        depositTaxPayouts: depositTaxPayouts,
        withdrawalPayouts: withdrawalPayouts,
        withdrawalTaxPayouts: withdrawalTaxPayouts
      }, approvalChain);

    // Apply payouts.
    await applyPayouts(depositTaxPayouts, withdrawalPayouts, withdrawalTaxPayouts);

    for (const node of publicSettings.authorityNodes) {
      if (node.walletAddress !== smartContract.getAccountAddress()) {
        approvalChain = validateSignedMessage(
          (await axios.post(`${getAuthorityLink(node)}/approvePayouts`, createSignedMessage({
            depositTaxPayouts,
            withdrawalPayouts,
            withdrawalTaxPayouts,
            approvalChain: approvalChain
          }))).data,
          node.walletAddress
        ).approvalChain;
      }
    }
  });

  app.post('/approvePayouts', ipfilter([publicSettings.authorityNodes[publicSettings.payoutCoordinator].location]), async (req, res) => {
    // Extract info.
    const { depositTaxPayouts, withdrawalPayouts, withdrawalTaxPayouts, approvalChain } =
      validateSignedMessage(req.body, publicSettings.authorityNodes[publicSettings.payoutCoordinator].walletAddress);

    // Validate payouts.
    await validatePayouts(depositTaxPayouts, withdrawalPayouts, withdrawalTaxPayouts);

    // Compute unspent and vouts.
    const { unspent, vouts } = await computeUnspentAndVouts(depositTaxPayouts, withdrawalPayouts, withdrawalTaxPayouts);

    // Validate vouts and sign.
    const approvalChainNext = await dingo.verifyAndSignRawTransaction(
      unspent, vouts,
      {
        depositTaxPayouts: depositTaxPayouts,
        withdrawalPayouts: withdrawalPayouts,
        withdrawalTaxPayouts: withdrawalTaxPayouts
      }, approvalChain);

    await applyPayouts(depositTaxPayouts, withdrawalPayouts, withdrawalTaxPayouts);

    res.send(createSignedMessage({ approvalChain: approvalChainNext }));
  });

  app.listen(publicSettings.port, () => {
    console.log(`Started on port ${publicSettings.port}`);
  });
})();

"use strict";

const express = require('express');
const database = require('./database.js');
const dingo = require('./dingo');
const smartContract = require('./smartContract.js');
const cors = require('cors');
const crypto = require('crypto');
const fs = require('fs');
const rateLimit = require("express-rate-limit");
const { IPBlockedError, default: ipfilter } = require('express-ip-filter-middleware');
const morgan = require('morgan');
const childProcess = require('child_process');
const AsyncLock = require('async-lock');
const util = require('util');
const https = require('https');
const tls = require('tls');
const got = require('got');
const { createProxyMiddleware } = require('http-proxy-middleware');

const LOCALHOST = '127.0.0.1';

function getAuthorityLink(x) {
  return `https://${x.hostname}:${x.port}`;
}

const FLAT_FEE = BigInt(dingo.toSatoshi('10'));
const DUST_THRESHOLD = BigInt(dingo.toSatoshi('1'));
const PAYOUT_NETWORK_FEE_PER_TX = BigInt(dingo.toSatoshi('20')); // Add this to network fee for each deposit / withdrawal.

function meetsTax(x) {
  return BigInt(x) >= FLAT_FEE;
}

function taxAmount(x) {
  if (!meetsTax(x)) {
    throw new Error('Amount fails to meet tax');
  }
  return (FLAT_FEE + (BigInt(x) - FLAT_FEE) / 100n).toString();
}

function amountAfterTax(x) {
  if (!meetsTax(x)) {
    throw new Error('Amount fails to meet tax');
  }
  return (BigInt(x) - (FLAT_FEE + (BigInt(x) - FLAT_FEE) / 100n)).toString();
}

function asyncHandler(fn) {
  return async function (req, res) {
    try {
      return await fn(req, res);
    } catch (err) {
      const stream = fs.createWriteStream("log.txt", {flags:'a'});
      stream.write(`>>>>> ERROR START [${(new Date()).toUTCString()}] >>>>>\n`);
      stream.write(err.stack + '\n' + req.path + '\n' + JSON.stringify(req.body, null, 2) + '\n');
      stream.write('<<<<<< ERROR END <<<<<<\n');
      stream.end();
      res.status(500).json(err.stack);
    }
  };
}

// wtf js
function isObject(x) {
  return typeof x === 'object' && x !== null && !Array.isArray(x);
}

(async function main() {

  // Load settings.
  const args = process.argv.slice(2);
  const settingsFolder = args.length >= 1 ? args[0] : 'settings';
  const databaseSettings = JSON.parse(fs.readFileSync(`${settingsFolder}/database.json`));
  const smartContractSettings = JSON.parse(fs.readFileSync(`${settingsFolder}/smartContract.json`));
  const publicSettings = JSON.parse(fs.readFileSync(`${settingsFolder}/public.json`));
  const privateSettings = JSON.parse(fs.readFileSync(`${settingsFolder}/private.DO_NOT_SHARE_THIS.json`));
  const dingoSettings = JSON.parse(fs.readFileSync(`${settingsFolder}/dingo.json`));
  const sslSettings = JSON.parse(fs.readFileSync(`${settingsFolder}/ssl.json`));

  // Initialize services.
  smartContract.loadProvider(smartContractSettings.provider);
  smartContract.loadContract(smartContractSettings.contractAbi, smartContractSettings.contractAddress);
  smartContract.loadAccount(privateSettings.walletPrivateKey);
  database.load(databaseSettings.databasePath);
  async function post(link, data) {
    const r = await got.post(
      link,
      {
        json: data,
        timeout: { request: 5000 }
      }).json();
    return r;
  }

  // DB write lock.
  const lock = new AsyncLock();
  const acquire = function (fn) {
    return lock.acquire('lock', fn);
  };

  // Stats lock.
  const statsLock = new AsyncLock();
  const acquireStats = function (fn) {
    return statsLock.acquire('statsLock', fn);
  };
  let stats = null;

  // Utility functions.
  const createIpFilter = (x) => ipfilter({
    mode: 'whitelist',
    allow: x
  });
  const createRateLimit = (windowS, count) => rateLimit({ windowMs: windowS * 1000, max: count });
  const createTimedAndSignedMessage = async (x) => {
    if (!isObject(x)) {
      throw new Error(`Cannot sign non-object ${JSON.stringify(x)}`);
    }
    const blockchainInfo = await dingo.getBlockchainInfo();
    x.valDingoHeight = blockchainInfo.blocks - dingoSettings.syncDelayThreshold;
    x.valDingoHash = await dingo.getBlockHash(blockchainInfo.blocks - dingoSettings.syncDelayThreshold);
    return smartContract.createSignedMessage(x);
  }
  const validateTimedAndSignedMessage = async (x, walletAddress, discard=true) => {
    if (!isObject(x.data)) {
      throw new Error('Data is non-object');
    }
    const blockchainInfo = await dingo.getBlockchainInfo();
    if (x.data.valDingoHeight < blockchainInfo.blocks - 2 * dingoSettings.syncDelayThreshold) {
      throw new Error('Message expired');
    }
    if (x.data.valDingoHash !== await dingo.getBlockHash(x.data.valDingoHeight)) {
      throw new Error('Verification failed: incorrect chain');
    }
    return smartContract.validateSignedMessage(x, walletAddress, discard);
  }
  const validateTimedAndSignedMessageOne = async (x, walletAddresses, discard=true) => {
    if (!isObject(x.data)) {
      throw new Error(`Data is non-object: ${JSON.stringify(x)}`);
    }
    const blockchainInfo = await dingo.getBlockchainInfo();
    if (x.data.valDingoHeight < blockchainInfo.blocks - 2 * dingoSettings.syncDelayThreshold) {
      throw new Error('Message expired');
    }
    if (x.data.valDingoHash !== await dingo.getBlockHash(x.data.valDingoHeight)) {
      throw new Error('Verification failed: incorrect chain');
    }
    return smartContract.validateSignedMessageOne(x, walletAddresses, discard);
  }


  // Compute version on launch.
  const version = {
    repository: childProcess.execSync('git config --get remote.origin.url').toString().trim(),
    hash: childProcess.execSync('git rev-parse HEAD').toString().trim(),
    timestamp: parseInt(childProcess.execSync('git --no-pager log --pretty=format:"%at" -n1').toString().trim()) * 1000,
    clean: childProcess.execSync('git diff --stat').toString().trim() === '',
    dingoVersion: await dingo.getClientVersion()
  };

  const app = express();
  app.use(cors());
  app.use(express.json());

  app.post('/ping', createRateLimit(10, 10), asyncHandler(async (req, res) => {
    res.send(await createTimedAndSignedMessage({ timestamp: Date.now() }));
  }));

  app.post('/generateDepositAddress', createRateLimit(20, 1), asyncHandler(async (req, res) => {
    const data = req.body;
    const mintAddress = data.mintAddress;
    if (!smartContract.isAddress(mintAddress)) {
      throw new Error('mintAddress missing or invalid');
    }

    res.send(await createTimedAndSignedMessage({
      mintAddress: data.mintAddress,
      depositAddress: await dingo.getNewAddress()
    }));
  }));

  app.post('/registerMintDepositAddress', createRateLimit(20, 1), asyncHandler(async (req, res) => {
    const data = req.body;
    if (data.generateDepositAddressResponses.length !== publicSettings.authorityNodes.length) {
      throw new Error('Incorrect authority count');
    }
    const generateDepositAddressResponses = await Promise.all(data.generateDepositAddressResponses.map(
      (x, i) => validateTimedAndSignedMessage(x, publicSettings.authorityNodes[i].walletAddress)
    ));
    if (!generateDepositAddressResponses.every((x) => x.mintAddress === generateDepositAddressResponses[0].mintAddress)) {
      throw new Error('Consensus failure on mint address');
    }
    const mintAddress = generateDepositAddressResponses[0].mintAddress;
    if (!smartContract.isAddress(mintAddress)) {
      throw new Error('mintAddress missing or invalid');
    }

    await acquire(async () => {
      const depositAddresses = generateDepositAddressResponses.map((x) => x.depositAddress);
      if (await database.hasUsedDepositAddresses(depositAddresses)) {
        throw new Error('At least one deposit address has been previously registered');
      }

      // Register as previously used.
      await database.registerUsedDepositAddresses(depositAddresses);

      // Compute multisigDepositAddress.
      const { address: multisigDepositAddress, redeemScript } = await dingo.createMultisig(
        publicSettings.authorityThreshold, depositAddresses
      );
      try {
        await dingo.importAddress(redeemScript);
      } catch (err) {
      }

      // Register mintDepositAddress.
      await database.registerMintDepositAddress(mintAddress, multisigDepositAddress, redeemScript);

      res.send(await createTimedAndSignedMessage({
        depositAddress: multisigDepositAddress
      }));
    });
  }));

  app.post('/queryMintBalance', createRateLimit(10, 10), asyncHandler(async (req, res) => {
    const data = req.body;
    const mintAddress = data.mintAddress;
    if (!smartContract.isAddress(mintAddress)) {
      throw new Error('mintAddress missing or invalid');
    }

    // Retrieve deposit address.
    const depositAddress = await database.getMintDepositAddress(mintAddress);

    if (depositAddress === null) {
      throw new Error('Mint address not registered');
    }

    // Retrieve deposited amount.
    const depositedAmount = dingo.toSatoshi((await dingo.getReceivedAmountByAddress(dingoSettings.depositConfirmations, depositAddress)).toString());
    const depositedAmountAfterTax = meetsTax(depositedAmount) ? amountAfterTax(depositedAmount) : 0n;
    const unconfirmedAmount = dingo.toSatoshi((await dingo.getReceivedAmountByAddress(0, depositAddress)).toString()) - depositedAmount;
    const unconfirmedAmountAfterTax = meetsTax(unconfirmedAmount) ? amountAfterTax(unconfirmedAmount) : 0n;

    // Retrieve minted amount.
    const {mintNonce, mintedAmount} = await smartContract.getMintHistory(mintAddress, depositAddress);

    res.send(await createTimedAndSignedMessage({
      mintNonce: mintNonce.toString(),
      mintAddress: mintAddress,
      depositAddress: depositAddress,
      depositedAmount: depositedAmountAfterTax.toString(),
      unconfirmedAmount: unconfirmedAmountAfterTax.toString(),
      mintedAmount: mintedAmount.toString()
    }));
  }));

  app.post('/createMintTransaction', createRateLimit(5, 1), asyncHandler(async (req, res) => {
    const data = req.body;
    const mintAddress = data.mintAddress;
    if (!(await smartContract.isAddress(mintAddress))) {
      throw new Error('mintAddress missing or invalid');
    }

    // Retrieve deposit address.
    const depositAddress = await database.getMintDepositAddress(mintAddress);
    if (depositAddress === null) {
      throw new Error('Mint address not registered');
    }

    // Retrieve deposited amount.
    const depositedAmount = dingo.toSatoshi((await dingo.getReceivedAmountByAddress(dingoSettings.depositConfirmations, depositAddress)).toString());
    const depositedAmountAfterTax = amountAfterTax(depositedAmount);

    // Retrieve minted amount.
    const {mintNonce, mintedAmount} = await smartContract.getMintHistory(mintAddress, depositAddress);

    let mintAmount = BigInt(depositedAmountAfterTax) - BigInt(mintedAmount);
    if (mintAmount < 0n) {
      mintAmount = 0n;
    }
    mintAmount = mintAmount.toString();

    const signature = smartContract.signMintTransaction(smartContractSettings.chainId, mintAddress, mintNonce, depositAddress, mintAmount);

    res.send(await createTimedAndSignedMessage({
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
  }));

  app.post('/queryBurnHistory', createRateLimit(10, 10), asyncHandler(async (req, res) => {
    const data = req.body;
    const burnAddress = data.burnAddress;
    if (!smartContract.isAddress(burnAddress)) {
      throw new Error('burnAddress missing or invalid');
    }

    const burnHistory = await smartContract.getBurnHistory(burnAddress);

    for (const i in burnHistory) {
      const w = await database.getWithdrawal(burnAddress, i);
      burnHistory[i].status = w === null ? null : BigInt(w.approvedTax) === BigInt(0) ? "SUBMITTED" : "APPROVED";
    }

    res.send(await createTimedAndSignedMessage({
      burnHistory: burnHistory
    }));
  }));

  app.post('/submitWithdrawal', createRateLimit(1, 5), asyncHandler(async (req, res) => {
    const data = req.body;
    const burnAddress = data.burnAddress;
    const burnIndex = data.burnIndex;
    if (!smartContract.isAddress(burnAddress)) {
      throw new Error('burnAddress missing or invalid');
    }

    await acquire(async () => {
      if (await database.getWithdrawal(burnAddress, burnIndex) !== null) {
        throw new Error('Withdrawal already submitted');
      }

      const { burnDestination, burnAmount } = await smartContract.getBurnHistory(burnAddress, burnIndex);
      if (!(await dingo.verifyAddress(burnDestination))) {
        throw new Error('Withdrawal address is not a valid Dingo address');
      }
      if (burnAmount < FLAT_FEE) {
        throw new Error('Amount too little');
      }

      await database.registerWithdrawal(burnAddress, burnIndex);

      res.send(await createTimedAndSignedMessage({}));
    });
  }));

  app.post('/log',
    createRateLimit(5, 1),
    asyncHandler(async (req, res) => {
      const data = req.body;
      await validateTimedAndSignedMessageOne(data, publicSettings.authorityNodes.map((x) => x.walletAddress));
      res.send({ log: await util.promisify(fs.readFile)('log.txt', 'utf8') });
    }));

  app.post('/stats',
    createRateLimit(5, 1),
    asyncHandler(async (req, res) => {
      acquireStats(async () => {
        if (stats === null || ((new Date()).getTime() - stats.time) >= 1000 * 60 * 10) {
          stats = {
            version: version,
            time: (new Date()).getTime(),
            publicSettings: publicSettings,
            dingoSettings: dingoSettings,
            smartContractSettings: {
              provider: smartContractSettings.provider,
              chainId: smartContractSettings.chainId,
              contractAddress: smartContractSettings.contractAddress
            },
            confirmedDeposits: {},
            unconfirmedDeposits: {},
            withdrawals: {},
            confirmedUtxos: {},
            unconfirmedUtxos: {}
          };

          stats.publicSettings.walletAddress = smartContract.getAccountAddress()

          // Process deposits.
          const depositAddresses = await database.getMintDepositAddresses();
          const computeDeposits = async (confirmations, output) => {
            output.count = depositAddresses.length;
            const depositedAmounts = await dingo.getReceivedAmountByAddresses(confirmations, depositAddresses.map((x) => x.depositAddress));
            const totalDepositedAmount = Object.values(depositedAmounts).reduce((a, b) => a + BigInt(dingo.toSatoshi(b.toString())), 0n).toString();
            const totalApprovableTax = Object.values(depositedAmounts).reduce((a, b) => {
              const amount = BigInt(dingo.toSatoshi(b.toString()));
              if (meetsTax(amount)) {
                return a + BigInt(taxAmount(amount));
              } else {
                return a;
              }
            }, 0n).toString();
            const totalApprovedTax = depositAddresses.reduce((a, b) => a + BigInt(b.approvedTax), 0n).toString();
            const remainingApprovableTax = (BigInt(totalApprovableTax) - BigInt(totalApprovedTax)).toString();

            output.totalDepositedAmount = totalDepositedAmount;
            output.totalApprovableTax = totalApprovableTax;
            output.totalApprovedTax = totalApprovedTax;
            output.remainingApprovableTax = remainingApprovableTax;
          };
          await computeDeposits(dingoSettings.depositConfirmations, stats.confirmedDeposits);
          await computeDeposits(0, stats.unconfirmedDeposits);

          // Process withdrawals.
          const withdrawals = await database.getWithdrawals();
          stats.withdrawals.count = withdrawals.length;
          const burnAmounts = withdrawals.length === 0
            ? []
            : (await smartContract.getBurnHistoryMultiple(withdrawals.map((x) => x.burnAddress), withdrawals.map((x) => x.burnIndex))).map((x) => x.burnAmount);
          stats.withdrawals.totalBurnedAmount = burnAmounts.reduce((a, b) => a + BigInt(b.toString()), 0n).toString();
          stats.withdrawals.totalApprovableAmount = 0n;
          stats.withdrawals.totalApprovedAmount = withdrawals.reduce((a, b) => a + BigInt(b.approvedAmount), 0n).toString();
          stats.withdrawals.totalApprovableTax = 0n;
          stats.withdrawals.totalApprovedTax = withdrawals.reduce((a, b) => a + BigInt(b.approvedTax), 0n).toString();
          for (const b of burnAmounts) {
            if (meetsTax(b)) {
              stats.withdrawals.totalApprovableAmount += BigInt(amountAfterTax(b));
              stats.withdrawals.totalApprovableTax += BigInt(taxAmount(b));
            }
          }
          stats.withdrawals.totalApprovableAmount = stats.withdrawals.totalApprovableAmount.toString();
          stats.withdrawals.totalApprovableTax = stats.withdrawals.totalApprovableTax.toString();
          stats.withdrawals.remainingApprovableAmount = (BigInt(stats.withdrawals.totalApprovableAmount) - BigInt(stats.withdrawals.totalApprovedAmount)).toString();
          stats.withdrawals.remainingApprovableTax = (BigInt(stats.withdrawals.totalApprovableTax) - BigInt(stats.withdrawals.totalApprovedTax)).toString();

          // Process UTXOs.
          const computeUtxos = async (changeConfirmations, depositConfirmations, output) => {
            const changeUtxos = await dingo.listUnspent(changeConfirmations, [dingoSettings.changeAddress]);
            const depositUtxos = await dingo.listUnspent(depositConfirmations, depositAddresses.map((x) => x.depositAddress));
            output.totalChangeBalance = changeUtxos.reduce((a, b) => a + BigInt(dingo.toSatoshi(b.amount.toString())), 0n).toString();
            output.totalDepositsBalance = depositUtxos.reduce((a, b) => a + BigInt(dingo.toSatoshi(b.amount.toString())), 0n).toString();
          };
          await computeUtxos(dingoSettings.changeConfirmations, dingoSettings.depositConfirmations, stats.confirmedUtxos);
          await computeUtxos(0, 0, stats.unconfirmedUtxos);
        }
        res.send(await createTimedAndSignedMessage(stats));
      });
    })
  );

  // Compute pending payouts:
  // 1) Tax payouts from deposits (10 + 1%).
  // 2) Withdrawal payouts.
  // 3) Tax payouts from withdrawals (10 + 1%).
  const computePendingPayouts = async (processDeposits, processWithdrawals) => {

    const depositTaxPayouts = []; // Track which deposit taxes are being paid.
    const withdrawalPayouts = []; // Track which withdrawals are being paid.
    const withdrawalTaxPayouts = []; // Track which withdrawal taxes are being paid.

    // Compute tax from deposits.
    if (processDeposits) {
      const deposited = await dingo.listReceivedByAddress(dingoSettings.depositConfirmations);
      const nonEmptyMintDepositAddresses = (await database.getMintDepositAddresses(Object.keys(deposited)));
      for (const a of nonEmptyMintDepositAddresses) {
        const depositedAmount = dingo.toSatoshi(deposited[a.depositAddress].amount.toString());
        if (meetsTax(depositedAmount)) {
          const approvedTax = BigInt(a.approvedTax);
          const approvableTax = BigInt(taxAmount(depositedAmount));
          if (approvableTax > approvedTax) {
            const payoutAmount = approvableTax - approvedTax;
            depositTaxPayouts.push({ depositAddress: a.depositAddress, amount: payoutAmount.toString() });
          } else if (approvableTax < approvedTax) {
            throw new Error('Deposit approved tax exceeds approvable');
          }
        }
      }
    }

    // Query unapproved withdrawals.
    if (processWithdrawals) {
      const unapprovedWithdrawals = await database.getUnapprovedWithdrawals();
      const burnAddresses = unapprovedWithdrawals.map((x) => x.burnAddress);
      const burnIndexes = unapprovedWithdrawals.map((x) => x.burnIndex);
      const burnDestinations = [];
      const burnAmounts = [];
      for (const b of await smartContract.getBurnHistoryMultiple(burnAddresses, burnIndexes)) {
        burnDestinations.push(b.burnDestination);
        burnAmounts.push(b.burnAmount);
      }
      // Compute unapproved withdrawal payouts and tax from withdrawals.
      for (const i in burnDestinations) {
        if (meetsTax(burnAmounts[i])) {
          withdrawalPayouts.push({
            burnAddress: burnAddresses[i],
            burnIndex: burnIndexes[i],
            burnDestination: burnDestinations[i],
            amount: amountAfterTax(burnAmounts[i]).toString() });
          withdrawalTaxPayouts.push({
            burnAddress: burnAddresses[i],
            burnIndex: burnIndexes[i],
            burnDestination: burnDestinations[i],
            amount: taxAmount(burnAmounts[i]).toString() });
        }
      }
    }

    return {
      depositTaxPayouts: depositTaxPayouts,
      withdrawalPayouts: withdrawalPayouts,
      withdrawalTaxPayouts: withdrawalTaxPayouts
    };
  };
  app.post('/computePendingPayouts',
    createRateLimit(5, 1),
    asyncHandler(async (req, res) => {
      const data = await validateTimedAndSignedMessageOne(req.body, publicSettings.authorityNodes.map((x) => x.walletAddress));
      res.send(await createTimedAndSignedMessage(await computePendingPayouts(data.processDeposits, data.processWithdrawals)));
    }));

  const validatePayouts = async (depositTaxPayouts, withdrawalPayouts, withdrawalTaxPayouts) => {

    const totalTax = depositTaxPayouts.reduce((a, b) => a + BigInt(b.amount), 0n) + withdrawalTaxPayouts.reduce((a, b) => a + BigInt(b.amount), 0n);
    const networkFee = BigInt(depositTaxPayouts.length + withdrawalPayouts.length) * PAYOUT_NETWORK_FEE_PER_TX;
    if (totalTax < networkFee) {
      throw new Error(`Insufficient tax to cover network fees of ${dingo.fromSatoshi(networkFee)}`);
    }

    // Check if requested tax from deposits does not exceed taxable.
    const deposited = await dingo.listReceivedByAddress(dingoSettings.depositConfirmations);
    const depositAddresses = {};
    (await database.getMintDepositAddresses(Object.keys(deposited))).forEach((x) => depositAddresses[x.depositAddress] = x);

    for (const p of depositTaxPayouts) {
      if (!(p.depositAddress in deposited)) {
        throw new Error('Dingo address has zero balance');
      }
      if (!(p.depositAddress in depositAddresses)) {
        throw new Error('Dingo address not registered');
      }
      const depositedAmount = dingo.toSatoshi(deposited[p.depositAddress].amount.toString());
      if (!meetsTax(depositedAmount)) {
        throw new Error('Deposited amount insufficient');
      }
      const approvedTax = BigInt(depositAddresses[p.depositAddress].approvedTax);
      const approvableTax = BigInt(taxAmount(depositedAmount));
      if (BigInt(p.amount) + approvedTax > approvableTax) {
        throw new Error('Requested tax amount more than remaining approvable tax');
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
      if (BigInt(withdrawal.approvedAmount) !== BigInt('0') || BigInt(withdrawal.approvedTax) !== BigInt('0')) {
        throw new Error('Withdrawal already approved');
      }
      const { burnDestination, burnAmount } = await smartContract.getBurnHistory(burnAddress, burnIndex);
      if (withdrawalPayouts[i].burnDestination !== burnDestination) {
        throw new Error('Withdrawal destination incorrect');
      }
      if (withdrawalTaxPayouts[i].burnDestination !== burnDestination) {
        throw new Error('Withdrawal tax destination incorrect');
      }
      if (BigInt(withdrawalPayouts[i].amount) !== BigInt(amountAfterTax(burnAmount))) {
        throw new Error('Withdrawal amount incorrect');
      }
      if (BigInt(withdrawalTaxPayouts[i].amount) !== BigInt(taxAmount(burnAmount))) {
        throw new Error('Withdrawal tax amount incorrect');
      }
    }

  };

  // Computes UTXOs among deposits and change.
  const computeUnspent = async () => {
    const changeUtxos = await dingo.listUnspent(dingoSettings.changeConfirmations, [dingoSettings.changeAddress]);
    const deposited = await dingo.listReceivedByAddress(dingoSettings.depositConfirmations);
    const nonEmptyMintDepositAddresses = (await database.getMintDepositAddresses(Object.keys(deposited)));
    const depositUtxos = await dingo.listUnspent(dingoSettings.depositConfirmations, nonEmptyMintDepositAddresses.map((x) => x.depositAddress));
    return changeUtxos.concat(depositUtxos);
  };
  app.post('/computeUnspent',
    createRateLimit(5, 1),
    asyncHandler(async (req, res) => {
      const data = await validateTimedAndSignedMessageOne(req.body, publicSettings.authorityNodes.map((x) => x.walletAddress));
      res.send(await createTimedAndSignedMessage({ unspent: await computeUnspent() }));
    }));

  // Checks if UTXOs exist among deposits and change.
  const validateUnspent = async (unspent) => {
    const _unspent = await computeUnspent();

    const hash = (x) => `${x.txid}|${x.vout}|${x.address}|${x.scriptPubKey}|${x.amount}`;

    const _unspent_set = new Set();
    for (const x of _unspent) {
      _unspent_set.add(hash(x));
    }

    for (const x of unspent) {
      if (!_unspent_set.has(hash(x))) {
        throw new Error('Non-existent UTXO');
      }
    }
  };

  // Compute vouts for raw transaction from payouts and UTXOs.
  const computeVouts = async (depositTaxPayouts, withdrawalPayouts, withdrawalTaxPayouts, unspent) => {

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
    const totalTax = depositTaxPayouts.reduce((a, b) => a + BigInt(b.amount), 0n) + withdrawalTaxPayouts.reduce((a, b) => a + BigInt(b.amount), 0n);
    const networkFee = BigInt(depositTaxPayouts.length + withdrawalPayouts.length) * PAYOUT_NETWORK_FEE_PER_TX;
    if (totalTax < networkFee) {
      throw new Error(`Insufficient tax for network fee of ${networkFee}`);
    }
    const taxPayoutPerPayee = (totalTax - networkFee) / BigInt(dingoSettings.taxPayoutAddresses.length);
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
    const totalUnspent = unspent.reduce((a, b) => a + BigInt(dingo.toSatoshi(b.amount.toString())), BigInt(0));
    const change = totalUnspent - totalPayout - networkFee; // Rounding errors from taxPayout / N is absorbed into change here.
    if (change < 0) {
      throw new Error('Insufficient funds');
    }
    if (change > 0) {
      if (dingoSettings.changeAddress in vouts) {
        vouts[dingoSettings.changeAddress] += change;
      } else {
        vouts[dingoSettings.changeAddress] = change;
      }
    }

    // Convert to string.
    const voutsFinal = {};
    for (const address of Object.keys(vouts)) {
      if (vouts[address] >= DUST_THRESHOLD) {
        voutsFinal[address] = dingo.fromSatoshi(vouts[address].toString());
      }
    }

    return voutsFinal;
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

  const makeApprovePayoutsHandler = (test) => {
    return async (req, res) => {
      await acquire(async () => {
        // Extract info.
        let { depositTaxPayouts, withdrawalPayouts, withdrawalTaxPayouts, unspent, approvalChain } =
          await validateTimedAndSignedMessage(req.body, publicSettings.authorityNodes[publicSettings.payoutCoordinator].walletAddress);

        // Validate unspent.
        await validateUnspent(unspent);

        // Validate payouts.
        await validatePayouts(depositTaxPayouts, withdrawalPayouts, withdrawalTaxPayouts);

        // Compute vouts.
        const vouts = await computeVouts(depositTaxPayouts, withdrawalPayouts, withdrawalTaxPayouts, unspent);

        if (approvalChain === null) {
          approvalChain = await dingo.createRawTransaction(unspent, vouts);
        }

        // Validate utxos and payouts against transaction and sign.
        await dingo.verifyRawTransaction(unspent, vouts, approvalChain);

        if (!test) {
          const approvalChainNext = await dingo.signRawTransaction(approvalChain);
          await applyPayouts(depositTaxPayouts, withdrawalPayouts, withdrawalTaxPayouts);
          res.send(await createTimedAndSignedMessage({ approvalChain: approvalChainNext }));
        } else {
          await dingo.signRawTransaction(approvalChain);
          res.send(await createTimedAndSignedMessage({ approvalChain: approvalChain }));
        }
      });
    };
  };
  app.post('/approvePayouts',
    asyncHandler(makeApprovePayoutsHandler(false)));
  app.post('/approvePayoutsTest',
    asyncHandler(makeApprovePayoutsHandler(true)));

  app.post('/dumpDatabase',
    async (req, res) => {
      const data = req.body;
      await validateTimedAndSignedMessageOne(data, publicSettings.authorityNodes.map((x) => x.walletAddress));
      res.send({ sql: await database.dump(databaseSettings.databasePath) });
    });

  let server = null;
  app.post('/dingoDoesAHarakiri',
    async (req, res) => {
      const data = req.body;
      await validateTimedAndSignedMessageOne(data, publicSettings.authorityNodes.map((x) => x.walletAddress));
      console.log(`TERMINATING! Suicide signal received from ${req.header('x-forwarded-for')}`);
      res.send();
      server.close();
    });

  app.use((err, req, res, _next) => {
    if (err instanceof IPBlockedError) {
      res.status(401).send(`Access forbidden from ${req.header('x-forwarded-for')}`);
    } else {
      res.status(err.status || 500).send('Internal server error');
    }
  })

  server = https.createServer({
    key: fs.readFileSync(sslSettings.keyPath),
    cert: fs.readFileSync(sslSettings.certPath),
    SNICallback: (domain, cb) => {
      cb(null, tls.createSecureContext({
        key: fs.readFileSync(sslSettings.keyPath),
        cert: fs.readFileSync(sslSettings.certPath),
      }));
    }
  }, app).listen(publicSettings.port, () => {
    console.log(`Started on port ${publicSettings.port}`);
  });

})();

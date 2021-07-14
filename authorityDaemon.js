"use strict";

const express = require('express');
const asyncHandler = require('express-async-handler')
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
const Table = require('tty-table');
const childProcess = require('child_process');

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

const FLAT_FEE = BigInt(dingo.toSatoshi('10'));

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

(async function main() {

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

  const createIpFilter = (x) => ipfilter(x, { log: false });

  const app = express();
  app.use(cors());
  app.use(express.json());
  //app.use(morgan('combined'));

  app.post('/ping', rateLimit({ windowMs: 10 * 1000, max: 10}), asyncHandler(async (req, res, next) => {
    res.send(createSignedMessage({ timestamp: Date.now() }));
  }));

  app.post('/generateDepositAddress', rateLimit({ windowMs: 20 * 1000, max: 1 }), asyncHandler(async (req, res, next) => {
    const data = req.body;
    const mintAddress = data.mintAddress;
    if (!smartContract.isAddress(mintAddress)) {
      throw new Error('mintAddress missing or invalid');
    }

    res.send(createSignedMessage({
      mintAddress: data.mintAddress,
      depositAddress: await dingo.getNewAddress()
    }));
  }));

  app.post('/registerMintDepositAddress', rateLimit({ windowMs: 20 * 1000, max: 1 }), asyncHandler(async (req, res, next) => {
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
  }));

  app.post('/queryMintBalance', rateLimit({ windowMs: 10 * 1000, max: 10 }), asyncHandler(async (req, res) => {
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
      const depositedAmountAfterTax = meetsTax(depositedAmount) ? amountAfterTax(depositedAmount) : 0n;

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
  }));

  app.post('/createMintTransaction', rateLimit({ windowMs: 5 * 1000, max: 1 }), asyncHandler(async (req, res, next) => {
    const data = req.body;
    const mintAddress = data.mintAddress;
    if (!smartContract.isAddress(mintAddress)) {
      throw new Error('mintAddress missing or invalid');
    }

    // Retrieve deposit address.
    const depositAddress = await database.acquire(() => database.getMintDepositAddress(mintAddress));

    // Retrieve deposited amount.
    const depositedAmount = dingo.toSatoshi((await dingo.getReceivedAmountByAddress(dingoSettings.confirmations, depositAddress)).toString());
    const depositedAmountAfterTax = amountAfterTax(depositedAmount);

    // Retrieve minted amount.
    const {mintNonce, mintedAmount} = await smartContract.getMintHistory(mintAddress, depositAddress);

    const mintAmount = (BigInt(depositedAmountAfterTax) - BigInt(mintedAmount)).toString();

    const signature = smartContract.signMintTransaction(smartContractSettings.chainId, mintAddress, mintNonce, depositAddress, mintAmount);

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
  }));

  app.post('/queryBurnHistory', rateLimit({ windowMs: 10 * 1000, max: 10 }), asyncHandler(async (req, res, next) => {
    const data = req.body;
    const burnAddress = data.burnAddress;
    if (!smartContract.isAddress(burnAddress)) {
      throw new Error('burnAddress missing or invalid');
    }

    const burnHistory = await smartContract.getBurnHistory(burnAddress);

    await database.acquire(async () => {
      for (const i in burnHistory) {
        const w = await database.getWithdrawal(burnAddress, i);
        burnHistory[i].status = w === null ? null : BigInt(w.approvedTax) === BigInt(0) ? "SUBMITTED" : "APPROVED";
      }
    });

    res.send(createSignedMessage({
      burnHistory: burnHistory
    }));
  }));

  app.post('/submitWithdrawal', rateLimit({ windowMs: 1 * 1000, max: 5 }), asyncHandler(async (req, res, next) => {
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
      if (burnAmount < FLAT_FEE) {
        throw new Error('Amount too little');
      }

      await database.registerWithdrawal(burnAddress, burnIndex);
      res.send(createSignedMessage({

      }));
    });
  }));

  app.post('/stats',
    rateLimit({ windowMs: 5 * 1000, max: 1 }),
    createIpFilter(publicSettings.authorityNodes.map((x) => x.location).concat([LOCALHOST])),
    asyncHandler(async (req, res, next) => {
      const stats = {
        version: {
          repository: childProcess.execSync('git config --get remote.origin.url').toString().trim(),
          hash: childProcess.execSync('git rev-parse HEAD').toString().trim(),
          timestamp: parseInt(childProcess.execSync('git --no-pager log --pretty=format:"%at" -n1').toString().trim())
        },
        publicSettings: publicSettings,
        dingoSettings: dingoSettings,
        smartContractSettings: {
          provider: smartContractSettings.provider,
          chainId: smartContractSettings.chainId,
          contractAddress: smartContractSettings.contractAddress
        },
        depositAddresses: {},
        withdrawals: {},
        utxos: {}
      };

      await database.acquire(async () => {
        const depositAddresses = await database.getMintDepositAddresses();
        stats.depositAddresses.count = depositAddresses.length;
        const depositedAmounts = await dingo.getReceivedAmountByAddresses(dingoSettings.confirmations, depositAddresses.map((x) => x.depositAddress));
        stats.depositAddresses.totalDepositedAmount = Object.values(depositedAmounts).reduce((a, b) => a + BigInt(dingo.toSatoshi(b.toString())), 0n).toString();
        stats.depositAddresses.totalApprovableTax = Object.values(depositedAmounts).reduce((a, b) => {
          const amount = BigInt(dingo.toSatoshi(b.toString()));
          if (meetsTax(amount)) {
            return a + BigInt(taxAmount(amount));
          } else {
            return a;
          }
        }, 0n).toString();
        stats.depositAddresses.totalApprovedTax = depositAddresses.reduce((a, b) => a + BigInt(b.approvedTax), 0n).toString();
        stats.depositAddresses.remainingApprovableTax = (BigInt(stats.depositAddresses.totalApprovableTax) - BigInt(stats.depositAddresses.totalApprovedTax)).toString();

        const withdrawals = await database.getWithdrawals();
        stats.withdrawals.count = withdrawals.length;
        const burnAmounts = withdrawals.length === 0
          ? []
          : (await smartContract.getBurnHistoryMultiple(withdrawals.map((x) => x.burnAddress), withdrawals.map((x) => x.burnIndex))).burnAmounts;
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

        const changeUtxos = await dingo.listUnspent(dingoSettings.confirmations, [dingoSettings.changeAddress]);
        const depositUtxos = await dingo.listUnspent(dingoSettings.confirmations, depositAddresses.map((x) => x.depositAddress));
        stats.utxos.totalChangeBalance = changeUtxos.reduce((a, b) => a + BigInt(dingo.toSatoshi(b.amount.toString())), 0n).toString();
        stats.utxos.totalDepositsBalance = depositUtxos.reduce((a, b) => a + BigInt(dingo.toSatoshi(b.amount.toString())), 0n).toString();
      });

      res.send(createSignedMessage(stats));
    })
  );

  app.post('/consensus', createIpFilter([LOCALHOST]), asyncHandler(async (req, res, next) => {
    const stats = await Promise.all(publicSettings.authorityNodes.map(async (x) => {
      try {
        return validateSignedMessage((await axios.post(`${getAuthorityLink(x)}/stats`)).data, x.walletAddress);
      } catch (err) {
        return undefined;
      }
    }));

    // Shared configurations.
    const dingoWidth = 20;
    function consensusCell (cell, columnIndex, rowIndex, rowData) {
      if (rowData.length === 0) {
        return this.style('YES', 'bgGreen', 'black');
      }

      let data = undefined;
      for (const row of rowData) {
        if (row[columnIndex] !== undefined && row[columnIndex] !== null && row[columnIndex] !== '') {
          if (data === undefined) {
            data = row[columnIndex];
          } else if (row[columnIndex] !== data) {
            return this.style('NO', 'bgRed', 'black');
          }
        }
      }
      return this.style('YES', 'bgGreen', 'black');
    }
    const nodeHeader = { alias: "Node", width: 11, formatter: function (x) {
      if (!x.startsWith('UNREACHABLE')) {
        return this.style(x, "bgWhite", "black");
      } else {
        return this.style(x.replace('UNREACHABLE', ''), "bgRed", "black");
      }
    }};
    function satoshiFormatter(x) {
      if (x === null || x === undefined || typeof(x) !== 'string' || x === '') {
        return '';
      } else {
        return dingo.fromSatoshi(x);
      }
    };


    let s = '';


    // Version info.
    const versionFlattened = [];
    for (const i in stats) {
      const stat = stats[i];
      if (stat === undefined) {
        versionFlattened.push([i, '', '', '']);
      } else {
        versionFlattened.push([
          i,
          stat.version.repository.toString(),
          stat.version.hash.toString(),
         (new Date(stat.version.timestamp * 1000)).toUTCString()
        ]);
      }
    }
    const versionHeader = [
      nodeHeader,
      { alias: 'Repository' },
      { alias: 'Commit Hash' },
      { alias: 'Commit Timestamp' }
    ];
    const versionFooter = ['Consensus'].concat(Array(versionHeader.length - 1).fill(consensusCell));
    s += '  [Version]'
    s += Table(versionHeader, versionFlattened, versionFooter).render();


    // Public Settings info.
    const publicSettingsFlattened = [];
    for (const i in stats) {
      const stat = stats[i];
      if (stat === undefined) {
        publicSettingsFlattened.push(['UNREACHABLE' + i, '', '', ''])
      } else {
        publicSettingsFlattened.push([
          i,
          stat.publicSettings.payoutCoordinator.toString(),
          stat.publicSettings.authorityThreshold.toString(),
          stat.publicSettings.authorityNodes.map((x) => `${x.location}:${x.port}\\${x.walletAddress}`).join(' ')
        ]);
      }
    }
    const publicSettingsHeader = [
      nodeHeader,
      { alias: 'Payout Coordinator' },
      { alias: 'Authority Threshold' },
      { alias: 'Authority Nodes', width: 70 }
    ];
    const publicSettingsFooter = ['Consensus'].concat(Array(publicSettingsHeader.length - 1).fill(consensusCell));
    s += '\n\n  [Public Settings]'
    s += Table(publicSettingsHeader, publicSettingsFlattened, publicSettingsFooter).render();


    // Dingo settings.
    const dingoSettingsFlattened = [];
    for (const i in stats) {
      const stat = stats[i];
      if (stat === undefined) {
        dingoSettingsFlattened.push(['UNREACHABLE' + i, '', '', '']);
      } else {
        dingoSettingsFlattened.push([
          i,
          stat.dingoSettings.changeAddress,
          stat.dingoSettings.confirmations.toString(),
          stat.dingoSettings.taxPayoutAddresses.join(' ')
        ]);
      }
    }
    const dingoSettingsHeader = [
      nodeHeader,
      { alias: 'Change Address' },
      { alias: 'Confirmations' },
      { alias: 'Tax Payout Addresses', width: 45 }
    ];
    const dingoSettingsFooter = ['Consensus'].concat(Array(dingoSettingsHeader.length - 1).fill(consensusCell));
    s += '\n\n  [Dingo Settings]'
    s += Table(dingoSettingsHeader, dingoSettingsFlattened, dingoSettingsFooter).render();


    // Smart contract settings.
    const smartContractSettingsFlattened = [];
    for (const i in stats) {
      const stat = stats[i];
      if (stat === undefined) {
        smartContractSettingsFlattened.push(['UNREACHABLE' + i, '', '', '']);
      } else {
        smartContractSettingsFlattened.push([
          i,
          stat.smartContractSettings.provider,
          stat.smartContractSettings.chainId,
          stat.smartContractSettings.contractAddress
        ]);
      }
    }
    const smartContractSettingsHeader = [
      nodeHeader,
      { alias: 'Provider' },
      { alias: 'Chain ID' },
      { alias: 'Contract Address' }
    ];
    const smartContractSettingsFooter = ['Consensus'].concat(Array(smartContractSettingsHeader.length - 1).fill(consensusCell));
    s += '\n\n  [Smart Contract Settings]'
    s += Table(smartContractSettingsHeader, smartContractSettingsFlattened, smartContractSettingsFooter).render();


    // Deposits.
    const depositStatsFlattened = [];
    for (const i in stats) {
      const stat = stats[i];
      if (stat === undefined) {
        depositStatsFlattened.push(['UNREACHABLE' + i, '', '', '', '', '']);
      } else {
        depositStatsFlattened.push([
          i,
          stat.depositAddresses.count.toString(),
          stat.depositAddresses.totalDepositedAmount,
          stat.depositAddresses.totalApprovableTax,
          stat.depositAddresses.totalApprovedTax,
          stat.depositAddresses.remainingApprovableTax
        ]);
      }
    }
    const depositHeader = [
      nodeHeader,
      { alias: "Addresses" },
      { alias: "Total Deposited", formatter: satoshiFormatter, width: dingoWidth },
      { alias: "Approvable Tax", formatter: satoshiFormatter, width: dingoWidth },
      { alias: "Approved Tax", formatter: satoshiFormatter, width: dingoWidth },
      { alias: "Remaining Tax", formatter: satoshiFormatter, width: dingoWidth }
    ];
    const depositFooter = ['Consensus'].concat(Array(depositHeader.length - 1).fill(consensusCell));
    s += '\n\n  [Deposit Addresses]';
    s += Table(depositHeader, depositStatsFlattened, depositFooter, { truncate: '...' }).render();


    // Withdrawals.
    const withdrawalStatsFlattened = [];
    for (const i in stats) {
      const stat = stats[i];
      if (stat === undefined) {
        withdrawalStatsFlattened.push(['UNREACHABLE' + i, '', '', '', '', '', '', '', '']);
      } else {
        withdrawalStatsFlattened.push([
          i,
          stat.withdrawals.count.toString(),
          stat.withdrawals.totalBurnedAmount,
          stat.withdrawals.totalApprovableAmount,
          stat.withdrawals.totalApprovedAmount,
          stat.withdrawals.remainingApprovableAmount,
          stat.withdrawals.totalApprovableTax,
          stat.withdrawals.totalApprovedTax,
          stat.withdrawals.remainingApprovableTax
        ]);
      }
    }
    const withdrawalHeader = [
      nodeHeader,
      { alias: "Submissions" },
      { alias: "Total Burned", formatter: satoshiFormatter, width: dingoWidth },
      { alias: "Approvable Amount", formatter: satoshiFormatter, width: dingoWidth },
      { alias: "Approved Amount", formatter: satoshiFormatter, width: dingoWidth },
      { alias: "Remaining Amount", formatter: satoshiFormatter, width: dingoWidth },
      { alias: "Approvable Tax", formatter: satoshiFormatter, width: dingoWidth },
      { alias: "Approved Tax", formatter: satoshiFormatter, width: dingoWidth },
      { alias: "Remaining Tax", formatter: satoshiFormatter, width: dingoWidth }
    ];
    const withdrawalFooter = ['Consensus'].concat(Array(withdrawalHeader.length - 1).fill(consensusCell));
    s += '\n\n  [Submitted Withdrawals]';
    s += Table(withdrawalHeader, withdrawalStatsFlattened, withdrawalFooter, { truncate: '...' }).render();


    // UTXOs.
    const utxoStatsFlattened = [];
    for (const i in stats) {
      const stat = stats[i];
      if (stat === undefined) {
        utxoStatsFlattened.push(['UNREACHABLE' + i, '', '']);
      } else {
        utxoStatsFlattened.push([
          i,
          stat.utxos.totalChangeBalance,
          stat.utxos.totalDepositsBalance
        ]);
      }
    }
    const utxoHeader = [
      nodeHeader,
      { alias: "Change Balance", formatter: satoshiFormatter, width: dingoWidth },
      { alias: "Deposits Balance", formatter: satoshiFormatter, width: dingoWidth },
    ];
    const utxoFooter = ['Consensus'].concat(Array(utxoHeader.length - 1).fill(consensusCell));
    s += '\n\n  [UTXOs]';
    s += Table(utxoHeader, utxoStatsFlattened, utxoFooter, { truncate: '...' }).render();


    s += '\n';
    res.send(s);
  }));



  // Compute pending payouts:
  // 1) Tax payouts from deposits (10 + 1%).
  // 2) Withdrawal payouts.
  // 3) Tax payouts from withdrawals (10 + 1%).
  const computePendingPayouts = async () => {

    const depositTaxPayouts = []; // Track which deposit taxes are being paid.
    const withdrawalPayouts = []; // Track which withdrawals are being paid.
    const withdrawalTaxPayouts = []; // Track which withdrawal taxes are being paid.

    // Compute tax from deposits.
    const deposited = await dingo.listReceivedByAddress(dingoSettings.confirmations);
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

    // Query unapproved withdrawals.
    const unapprovedWithdrawals = await database.getUnapprovedWithdrawals();
    const burnAddresses = unapprovedWithdrawals.map((x) => x.burnAddress);
    const burnIndexes = unapprovedWithdrawals.map((x) => x.burnIndex);
    const { burnDestinations, burnAmounts } = await smartContract.getBurnHistoryMultiple(burnAddresses, burnIndexes);
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

    return {
      depositTaxPayouts: depositTaxPayouts,
      withdrawalPayouts: withdrawalPayouts,
      withdrawalTaxPayouts: withdrawalTaxPayouts
    };
  };

  const validatePayouts = async (depositTaxPayouts, withdrawalPayouts, withdrawalTaxPayouts) => {

    const totalTax = depositTaxPayouts.reduce((a, b) => a + BigInt(b.amount), 0n) + withdrawalTaxPayouts.reduce((a, b) => a + BigInt(b.amount), 0n);
    if (totalTax < FLAT_FEE) {
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
    const totalTax = depositTaxPayouts.reduce((a, b) => a + BigInt(b.amount), 0n) + withdrawalTaxPayouts.reduce((a, b) => a + BigInt(b.amount), 0n);
    const taxPayoutPerPayee = (totalTax - FLAT_FEE) / BigInt(dingoSettings.taxPayoutAddresses.length);
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
    const unspent = await dingo.listUnspent(dingoSettings.confirmations, nonEmptyMintDepositAddresses.map((x) => x.depositAddress).concat(dingoSettings.changeAddress));
    const totalUnspent = unspent.reduce((a, b) => a + BigInt(dingo.toSatoshi(b.amount.toString())), BigInt(0));
    const change = totalUnspent - totalPayout - FLAT_FEE; // Rounding errors from taxPayout / N is absorbed into change here.
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

  app.post('/executePayouts', createIpFilter([LOCALHOST]), asyncHandler(async (req, res, next) => {
    let depositTaxPayouts = undefined;
    let withdrawalPayouts = undefined;
    let withdrawalTaxPayouts = undefined;
    let approvalChain = undefined;

    await database.acquire(async () => {

      const pendingPayouts = await computePendingPayouts();
      depositTaxPayouts = pendingPayouts.depositTaxPayouts;
      withdrawalPayouts = pendingPayouts.withdrawalPayouts;
      withdrawalTaxPayouts = pendingPayouts.withdrawalTaxPayouts;

      const totalDepositTaxPayout = depositTaxPayouts.reduce((a, b) => a + BigInt(b.amount), 0n).toString();
      const totalWithdrawalPayout = withdrawalPayouts.reduce((a, b) => a + BigInt(b.amount), 0n).toString();
      const totalWithdrawalTaxPayout = withdrawalTaxPayouts.reduce((a, b) => a + BigInt(b.amount), 0n).toString();
      console.log(`Total deposit tax payout = ${dingo.fromSatoshi(totalDepositTaxPayout)}`);
      console.log(`Total withdrawal payout = ${dingo.fromSatoshi(totalWithdrawalPayout)}`);
      console.log(`Total withdrawal tax payout = ${dingo.fromSatoshi(totalWithdrawalTaxPayout)}`);

      await validatePayouts(depositTaxPayouts, withdrawalPayouts, withdrawalTaxPayouts);
      const { unspent, vouts } = await computeUnspentAndVouts(depositTaxPayouts, withdrawalPayouts, withdrawalTaxPayouts);

      // Compute approval chain.
      approvalChain = await dingo.createRawTransaction(
        unspent, vouts,
        {
          depositTaxPayouts: depositTaxPayouts,
          withdrawalPayouts: withdrawalPayouts,
          withdrawalTaxPayouts: withdrawalTaxPayouts,
          unspent: unspent,
          vouts: vouts
        });
    });

    for (const i in publicSettings.authorityNodes) {
      const node = publicSettings.authorityNodes[i];
      console.log(`Requesting approval from Node ${i} at ${node.location} (${node.walletAddress})...`);
      approvalChain = validateSignedMessage(
        (await axios.post(`${getAuthorityLink(node)}/approvePayouts`, createSignedMessage({
          depositTaxPayouts: depositTaxPayouts,
          withdrawalPayouts: withdrawalPayouts,
          withdrawalTaxPayouts: withdrawalTaxPayouts,
          approvalChain: approvalChain
        }))).data,
        node.walletAddress
      ).approvalChain;
      console.log('  -> Success!');
    }

    console.log(`Sending raw transaction:\n${approvalChain}`);
    const hash = await dingo.sendRawTranscation(approvalChain);
    console.log(`Success! Transaction hash: ${hash}`);

    res.send(createSignedMessage({
      rawTransaction: approvalChain,
      transactionHash: hash
    }));

  }));

  app.post('/approvePayouts', createIpFilter([publicSettings.authorityNodes[publicSettings.payoutCoordinator].location]), asyncHandler(async (req, res, next) => {
    await database.acquire(async () => {
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
          withdrawalTaxPayouts: withdrawalTaxPayouts,
          unspent: unspent,
          vouts: vouts
        }, approvalChain);

      await applyPayouts(depositTaxPayouts, withdrawalPayouts, withdrawalTaxPayouts);

      res.send(createSignedMessage({ approvalChain: approvalChainNext }));
    });
  }));

  app.listen(publicSettings.port, () => {
    console.log(`Started on port ${publicSettings.port}`);
  });
})();

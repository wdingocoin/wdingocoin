const Table = require('tty-table');
const chalk = require('chalk');
const database = require('./database.js');
const dingo = require('./dingo');
const fs = require('fs');
const got = require('got');
const smartContract = require('./smartContract.js');

function getAuthorityLink(x) {
  return `https://${x.hostname}:${x.port}`;
}

function getStyledAuthorityLink(x) {
  return chalk.blue.bold(`[${getAuthorityLink(x)}]`)
}

function getStyledError(code, message) {
  if (code !== null && code !== undefined) {
    if (message !== null && message !== undefined) {
      return chalk.red.bold(`Error ${code}: ${message}`);
    } else {
      return chalk.red.bold(`Error ${code}`);
    }
  } else {
    if (message !== null && message !== undefined) {
      return chalk.red.bold(`Error: ${message}`);
    } else {
      return chalk.red.bold(`Error`);
    }
  }
}

// wtf js
function isObject(x) {
  return typeof x === 'object' && x !== null && !Array.isArray(x);
}

function parseBool(s) {
  if (s === 'true') {
    return true;
  } else if (s === 'false') {
    return false;
  } else {
    throw new Error(`Unable to parse bool string: ${s}`);
  }
}

(function() {

  const args = process.argv.slice(2);
  const settingsFolder = args.length >= 1 ? args[0] : 'settings';
  const databaseSettings = JSON.parse(fs.readFileSync(`${settingsFolder}/database.json`));
  const smartContractSettings = JSON.parse(fs.readFileSync(`${settingsFolder}/smartContract.json`));
  const publicSettings = JSON.parse(fs.readFileSync(`${settingsFolder}/public.json`));
  const privateSettings = JSON.parse(fs.readFileSync(`${settingsFolder}/private.DO_NOT_SHARE_THIS.json`));
  const dingoSettings = JSON.parse(fs.readFileSync(`${settingsFolder}/dingo.json`));

  smartContract.loadProvider(smartContractSettings.provider);
  smartContract.loadContract(smartContractSettings.contractAbi, smartContractSettings.contractAddress);
  if (privateSettings.walletPrivateKey != null && privateSettings.walletPrivateKey !== undefined && privateSettings.walletPrivateKey !== "0xExampleWhichYouShouldReplace") {
    smartContract.loadAccount(privateSettings.walletPrivateKey);
  }
  async function post(link, data) {
    const r = await got.post(
      link,
      {
        json: data,
        timeout: { request: 10000 }
      }).json();
    return r;
  }
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


  const repl = require('repl').start({ prompt: chalk.bold('wDingocoin > '), eval: eval, writer: (x) => x, ignoreUndefined: true });
  require('repl.history')(repl, '.cli_history');

  const commandCallbacks = {
    help: help,

    createMintDepositAddress: createMintDepositAddress,
    queryMintBalance: queryMintBalance,
    createMintTransaction: createMintTransaction,
    queryBurnHistory: queryBurnHistory,
    createBurnTransaction: createBurnTransaction,
    submitWithdrawal: submitWithdrawal,

    executePayouts: executePayouts,
    executePayoutsTest: executePayoutsTest,

    consensus: consensus,
    log: log,
    syncDatabase: syncDatabase,
    dingoDoesAHarakiri: dingoDoesAHarakiri
  };

  async function eval(cmd, context, filename, callback) {
    const tokens = cmd.trim().split(' ').filter((x) => x !== '');
    if (cmd.trim().length === 0) {
      callback(null);
    } else if (!(tokens[0] in commandCallbacks)) {
      callback(`Unknown command: ${tokens[0]}`);
    } else {
      callback(null, await commandCallbacks[tokens[0]](...tokens.slice(1)));
    }
  }

  function help() {
    console.log(
`
Available commands:

  ${chalk.bold('help')}: Prints this command.

  ${chalk.bold('createMintDepositAddress <walletAddress>')}: Creates a deposit address for <wallet address>.
  ${chalk.bold('queryMintBalance <walletAddress>')}: Queries the amount of deposited Dingocoins and minted wDingocoins for <wallet address>.
  ${chalk.bold('createMintTransaction <walletAddress>')}: Creates a signed transaction to mint all remaining mintable wDingocoins for <wallet address>, to be submitted to the smart contract.
  ${chalk.bold('queryBurnHistory <walletAddress>')}: Queries the amount of burned wDingocoins and withdrawn Dingocoins for <wallet address>.
  ${chalk.bold('createBurnTransaction <amount> <destination>')}: Creates a transaction to burn <amount> of wDingocoins, which can be submitted for withdrawal to <destination> on the Dingocoin Mainnet.
  ${chalk.bold('submitWithdrawal <walletAddress> <index>')}: Submits the <index>-th wDingocoin burn for withdrawal of Dingocoins for <wallet address>.

  ${chalk.bold('executePayouts <processDeposits> <processWithdrawals>')}: ${chalk.bold.red('[COORDINATOR ONLY]')} Executes payouts.
  ${chalk.bold('executePayoutsTest <processDeposits> <processWithdrawals>')}: ${chalk.bold.red('[COORDINATOR ONLY]')} Tests the execution of payouts.

  ${chalk.bold('consensus')}: Retrieves the state of all nodes and checks the consensus of state.
  ${chalk.bold('log <nodeIndex>')}: ${chalk.bold.red('[AUTHORITY ONLY]')} Retrieves the log from node <nodeIndex>.
  ${chalk.bold('syncDatabase <nodeIndex>')}: ${chalk.bold.red('[AUTHORITY ONLY]')} Replaces the local database with that downloaded from node <nodeIndex>.
  ${chalk.bold('dingoDoesAHarakiri <nodeIndex>')}: ${chalk.bold.red('[AUTHORITY ONLY]')} Sends a suicide signal to node <nodeIndex>.
  ${chalk.bold('dingoDoesAHarakiri')}: ${chalk.bold.red('[AUTHORITY ONLY]')} Sends a suicide signal to all nodes.
`);
  }

  async function createMintDepositAddress(mintAddress) {

    const results1 = []
    console.log('Requesting new individual deposit addresses from nodes...');
    for (const x of publicSettings.authorityNodes) {
      process.stdout.write(`  ${getStyledAuthorityLink(x)} ${chalk.bold('->')} `);
      try {
        const result = await post(`${getAuthorityLink(x)}/generateDepositAddress`, { mintAddress: mintAddress });
        results1.push(result);
        console.log(`pubKey: ${result.data.depositAddress}`);
      } catch (error) {
        results1.push(undefined);
        if (error.response) { console.log(getStyledError(error.response.statusCode, error.response.body)); }
        else { console.log(getStyledError(null, error.message)); }
      }
    }
    if (results1.some((x) => x === undefined)) {
      console.log(getStyledError(null, 'Failed to collect new individual deposit addresses from all nodes. Aborting...'));
      return;
    }

    const results2 = [];
    console.log('Registering new multisig deposit address with nodes...');
    for (const x of publicSettings.authorityNodes) {
      process.stdout.write(`  ${getStyledAuthorityLink(x)} ${chalk.bold('->')} `);
      try {
        const result = smartContract.validateSignedMessage(await post(
          `${getAuthorityLink(x)}/registerMintDepositAddress`,
          { mintAddress: mintAddress, generateDepositAddressResponses: results1 }), x.walletAddress);
        results2.push(result);
        console.log(`multisigDepositAddress: ${result.depositAddress}`);
      } catch (error) {
        results2.push(undefined);
        if (error.response) { console.log(getStyledError(error.response.statusCode, error.response.body)); }
        else { console.log(getStyledError(null, error.message)); }
      }
    }
    if (results2.some((x) => x === undefined)) {
      return;
    }

    if (!results2.every((x) => x.depositAddress === results2[0].depositAddress)) {
      return console.log(getStyledError(null, 'Consensus failure on multisig deposit address'));
    }

    return `Multisig deposit address: ${results2[0].depositAddress}`;
  }

  async function queryMintBalance(mintAddress) {
    for (const x of publicSettings.authorityNodes) {
      process.stdout.write(`  ${getStyledAuthorityLink(x)} ${chalk.bold('->')} `);
      try {
        const result = smartContract.validateSignedMessage(await post(
          `${getAuthorityLink(x)}/queryMintBalance`,
          { mintAddress: mintAddress }), x.walletAddress);
        console.log(`mintedAmount: ${dingo.fromSatoshi(result.mintedAmount)}, depositedAmount: ${dingo.fromSatoshi(result.depositedAmount)}, unconfirmedAmount: ${dingo.fromSatoshi(result.unconfirmedAmount)}, depositAddress: ${result.depositAddress}`);
      } catch (error) {
        if (error.response) { console.log(getStyledError(error.response.statusCode, error.response.body)); }
        else { console.log(getStyledError(null, error.message)); }
      }
    }
  }

  async function createMintTransaction(mintAddress) {
    console.log(chalk.bold('Retrieving signatures from authority nodes...'));
    const results = [];
    for (const x of publicSettings.authorityNodes) {
      process.stdout.write(`  ${getStyledAuthorityLink(x)} ${chalk.bold('->')} `);
      try {
        const result = smartContract.validateSignedMessage(await post(
          `${getAuthorityLink(x)}/createMintTransaction`,
          { mintAddress: mintAddress }), x.walletAddress);
        results.push(result);
        console.log(
          `\n    depositAddress: ${result.depositAddress}\n` +
          `    mintNonce: ${result.mintNonce}, mintAmount: ${dingo.fromSatoshi(result.mintAmount)} (= ${result.mintAmount} satoshi)\n` +
          `    signature (V): ${result.onContractVerification.v}\n` +
          `    signature (R): ${result.onContractVerification.r}\n` +
          `    signature (S): ${result.onContractVerification.s}`);
      } catch (error) {
        results.push(undefined);
        if (error.response) { console.log(getStyledError(error.response.statusCode, error.response.body)); }
        else { console.log(getStyledError(null, error.message)); }
      }
    }
    console.log(
      chalk.bold(`Use the following details to call, with your wallet, the \`mint\` function of the smart contract (https://bscscan.com/token/${smartContractSettings.contractAddress}#writeContract).\n`) +
      chalk.red.bold('  (DO NOT COPY ANY WHITE SPACES OR YOUR TRANSACTION MAY FAIL!)\n') +
      `  depositAddress: ${results.filter((x) => x !== undefined)[0].depositAddress}\n` +
      `  amount: ${results.filter((x) => x !== undefined)[0].mintAmount}\n` +
      `  signV: ${results.map((x) => x === undefined ? '0x0' : x.onContractVerification.v.toString()).join(',')}\n` +
      `  signR: ${results.map((x) => x === undefined ? '0x0' : x.onContractVerification.r.toString()).join(',')}\n` +
      `  signS: ${results.map((x) => x === undefined ? '0x0' : x.onContractVerification.s.toString()).join(',')}\n` +
      chalk.bold('Frequently asked questions:\n') +
      '  - What\'s with the large amount? -> The smart contract takes in Satoshis as parameters. Hence the amount is 100,000,000 times more.'
    );
  }

  async function queryBurnHistory(burnAddress) {
    for (const x of publicSettings.authorityNodes) {
      process.stdout.write(`  ${getStyledAuthorityLink(x)} ${chalk.bold('->')} `);
      try {
        const result = smartContract.validateSignedMessage(await post(
          `${getAuthorityLink(x)}/queryBurnHistory`,
          { burnAddress: burnAddress }), x.walletAddress).burnHistory;
        console.log();
        for (const i in result) {
          console.log(`    index: ${i}, amount: ${dingo.fromSatoshi(result[i].burnAmount)}, destination: ${result[i].burnDestination}, status: ${result[i].status}`);
        }
      } catch (error) {
        if (error.response) { console.log(getStyledError(error.response.statusCode, error.response.body)); }
        else { console.log(getStyledError(null, error.message)); }
      }
    }
  }

  function createBurnTransaction(amount, destination) {
    console.log(
      chalk.bold(`Use the following details to call, with your wallet, the \`burn\` function of the smart contract (https://bscscan.com/token/${smartContractSettings.contractAddress}#writeContract).\n`) +
      chalk.red.bold('  (DO NOT COPY ANY WHITE SPACES OR YOUR TRANSACTION MAY FAIL!)\n') +
      `  amount: ${dingo.toSatoshi(amount)}\n` +
      `  destination: ${destination}\n` +
      chalk.bold('Frequently asked questions:\n') +
      '  - What\'s with the large amount? -> The smart contract takes in Satoshis as parameters. Hence the amount is 100,000,000 times more.');
  }

  async function submitWithdrawal(burnAddress, burnIndex) {
    for (const x of publicSettings.authorityNodes) {
      process.stdout.write(`  ${getStyledAuthorityLink(x)} ${chalk.bold('->')} `);
      try {
        const result = smartContract.validateSignedMessage(await post(
          `${getAuthorityLink(x)}/submitWithdrawal`,
          { burnAddress: burnAddress, burnIndex: burnIndex }), x.walletAddress).burnHistory;
        console.log('OK');
      } catch (error) {
        if (error.response) { console.log(getStyledError(error.response.statusCode, error.response.body)); }
        else { console.log(getStyledError(null, error.message)); }
      }
    }
  }

  const executePayoutsHandler = async (processDeposits, processWithdrawals, test) => {
    let depositTaxPayouts = null;
    let withdrawalPayouts = null;
    let withdrawalTaxPayouts = null;
    let unspent = null;

    console.log('Retrieving pending payouts...');
    for (const i in publicSettings.authorityNodes) {
      const node = publicSettings.authorityNodes[i];
      console.log(`  Requesting pending payouts from Node ${i} at ${node.hostname} (${node.walletAddress})...`);
      const { depositTaxPayouts: _depositTaxPayouts, withdrawalPayouts: _withdrawalPayouts, withdrawalTaxPayouts: _withdrawalTaxPayouts } =
        await validateTimedAndSignedMessage(
          await post(`${getAuthorityLink(node)}/computePendingPayouts`, await createTimedAndSignedMessage({ processDeposits: processDeposits, processWithdrawals: processWithdrawals })),
          node.walletAddress);
      const totalDepositTaxPayout = _depositTaxPayouts.reduce((a, b) => a + BigInt(b.amount), 0n).toString();
      const totalWithdrawalPayout = _withdrawalPayouts.reduce((a, b) => a + BigInt(b.amount), 0n).toString();
      const totalWithdrawalTaxPayout = _withdrawalTaxPayouts.reduce((a, b) => a + BigInt(b.amount), 0n).toString();
      console.log(`    Total deposit tax = ${dingo.fromSatoshi(totalDepositTaxPayout)}`);
      for (const p of _depositTaxPayouts) {
        console.log(`      ${p.depositAddress} -> ${dingo.fromSatoshi(p.amount)}`);
      }
      console.log(`    Total withdrawal = ${dingo.fromSatoshi(totalWithdrawalPayout)}`);
      for (const p of _withdrawalPayouts) {
        console.log(`      ${p.burnDestination} -> ${dingo.fromSatoshi(p.amount)}`);
      }
      console.log(`    Total withdrawal tax = ${dingo.fromSatoshi(totalWithdrawalTaxPayout)}`);
      for (const p of _withdrawalTaxPayouts) {
        console.log(`      ${p.burnDestination} -> ${dingo.fromSatoshi(p.amount)}`);
      }

      if (depositTaxPayouts === null) {
        depositTaxPayouts = _depositTaxPayouts;
        withdrawalPayouts = _withdrawalPayouts;
        withdrawalTaxPayouts = _withdrawalTaxPayouts;
      } else {
        depositTaxPayouts = depositTaxPayouts.filter((x) => _depositTaxPayouts.some((y) =>
          y.depositAddress === x.depositAddress &&
          y.amount === x.amount
        ));
        withdrawalPayouts = withdrawalPayouts.filter((x) => _withdrawalPayouts.some((y) =>
          y.burnAddress === x.burnAddress &&
          y.burnIndex === x.burnIndex &&
          y.burnDestination === x.burnDestination &&
          y.amount === x.amount
        ));
        withdrawalTaxPayouts = withdrawalTaxPayouts.filter((x) => _withdrawalTaxPayouts.some((y) =>
          y.burnAddress === x.burnAddress &&
          y.burnIndex === x.burnIndex &&
          y.burnDestination === x.burnDestination &&
          y.amount === x.amount
        ));
      }
    }
    console.log('\n');
    if (!processDeposits) {
      depositTaxPayouts = [];
    }
    if (!processWithdrawals) {
      withdrawalPayouts = [];
      withdrawalTaxPayouts = [];
    }

    console.log('Pending payouts consensus =');
    const totalDepositTaxPayout = depositTaxPayouts.reduce((a, b) => a + BigInt(b.amount), 0n).toString();
    const totalWithdrawalPayout = withdrawalPayouts.reduce((a, b) => a + BigInt(b.amount), 0n).toString();
    const totalWithdrawalTaxPayout = withdrawalTaxPayouts.reduce((a, b) => a + BigInt(b.amount), 0n).toString();
    console.log(`  Total deposit tax = ${dingo.fromSatoshi(totalDepositTaxPayout)}`);
    for (const p of depositTaxPayouts) {
      console.log(`    ${p.depositAddress} -> ${dingo.fromSatoshi(p.amount)}`);
    }
    console.log(`  Total withdrawal = ${dingo.fromSatoshi(totalWithdrawalPayout)}`);
    for (const p of withdrawalPayouts) {
      console.log(`    ${p.burnDestination} -> ${dingo.fromSatoshi(p.amount)}`);
    }
    console.log(`  Total withdrawal tax = ${dingo.fromSatoshi(totalWithdrawalTaxPayout)}`);
    for (const p of withdrawalTaxPayouts) {
      console.log(`    ${p.burnDestination} -> ${dingo.fromSatoshi(p.amount)}`);
    }
    console.log('\n');

    console.log('Retrieving unspent...');
    for (const i in publicSettings.authorityNodes) {
      const node = publicSettings.authorityNodes[i];
      console.log(`  Requesting unspent from Node ${i} at ${node.hostname} (${node.walletAddress})...`);
      const { unspent: _unspent } = await validateTimedAndSignedMessage(
          await post(`${getAuthorityLink(node)}/computeUnspent`, await createTimedAndSignedMessage({})),
          node.walletAddress);
      for (const u of _unspent) {
        console.log(`      ${u.txid} -> ${u.amount}`);
      }
      if (unspent === null) {
        unspent = _unspent;
      } else {
        unspent = unspent.filter((x) => ((a) => a.length === 1 && dingo.toSatoshi(a[0].amount.toString()) === dingo.toSatoshi(x.amount.toString()))(_unspent.filter((y) => y.txid === x.txid && y.vout === x.vout)));
      }
    }
    console.log('\n');

    console.log('Unspent consensus = ');
    for (const u of unspent) {
      console.log(`    ${u.txid} -> ${u.amount}`);
    }
    console.log('\n');

    // Compute approval chain.
    let approvalChain = null;
    console.log(`Approval chain = \n${approvalChain}`);
    console.log('\n');

    console.log('Running test...');
    for (const i in publicSettings.authorityNodes) {
      const node = publicSettings.authorityNodes[i];
      console.log(`  Requesting approval from Node ${i} at ${node.hostname} (${node.walletAddress})...`);

      const approvalChainNext = (await validateTimedAndSignedMessage(
        (await post(`${getAuthorityLink(node)}/approvePayoutsTest`, await createTimedAndSignedMessage({
          depositTaxPayouts: depositTaxPayouts,
          withdrawalPayouts: withdrawalPayouts,
          withdrawalTaxPayouts: withdrawalTaxPayouts,
          unspent: unspent,
          approvalChain: approvalChain
        }))),
        node.walletAddress)).approvalChain;

      console.log('    -> Success!');
      console.log(approvalChainNext);
    }
    console.log('\n');

    if (!test) {
      console.log('Executing...');
      for (const i in publicSettings.authorityNodes) {
        const node = publicSettings.authorityNodes[i];
        console.log(`  Requesting approval from Node ${i} at ${node.hostname} (${node.walletAddress})...`);

        const approvalChainNext = (await validateTimedAndSignedMessage(
          (await post(`${getAuthorityLink(node)}/approvePayouts`, await createTimedAndSignedMessage({
            depositTaxPayouts: depositTaxPayouts,
            withdrawalPayouts: withdrawalPayouts,
            withdrawalTaxPayouts: withdrawalTaxPayouts,
            unspent: unspent,
            approvalChain: approvalChain
          }))),
          node.walletAddress)).approvalChain;

        approvalChain = approvalChainNext;
        console.log('    -> Success!');
        console.log(approvalChainNext);
      }

      console.log(`  Sending raw transaction:\n${approvalChain}`);
      const hash = await dingo.sendRawTranscation(approvalChain);
      console.log(`  Success! Transaction hash: ${hash}`);
      console.log('\n');
    }
  };
  async function executePayouts(processDeposits, processWithdrawals) {
    processDeposits = parseBool(processDeposits);
    processWithdrawals = parseBool(processWithdrawals);
    if (processDeposits === false && processWithdrawals === false) {
      throw new Error('At least one of deposits or withdrawals must be processed');
    }
    await executePayoutsHandler(processDeposits, processWithdrawals, false);
  }
  async function executePayoutsTest(processDeposits, processWithdrawals) {
    processDeposits = parseBool(processDeposits);
    processWithdrawals = parseBool(processWithdrawals);
    if (processDeposits === false && processWithdrawals === false) {
      throw new Error('At least one of deposits or withdrawals must be processed');
    }
    await executePayoutsHandler(processDeposits, processWithdrawals, true);
  }

  async function consensus() {

    const stats = [];
    for (const x of publicSettings.authorityNodes) {
      process.stdout.write(`  ${getStyledAuthorityLink(x)} ${chalk.bold('->')} `);
      try {
        const result = smartContract.validateSignedMessage(await post(`${getAuthorityLink(x)}/stats`), x.walletAddress);
        stats.push(result);
        console.log('OK');
      } catch (error) {
        stats.push(undefined);
        if (error.response) { console.log(getStyledError(error.response.statusCode, error.response.body)); }
        else { console.log(getStyledError(null, error.message)); }
      }
    }


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
        versionFlattened.push(['UNREACHABLE' + i, '', '', '', '', '']);
      } else {
        versionFlattened.push([
          i,
          stat.version.repository.toString(),
          stat.version.hash.toString(),
          (new Date(stat.version.timestamp)).toUTCString(),
          stat.version.clean ? 'Yes' : 'No',
          stat.version.dingoVersion === undefined ? '' : stat.version.dingoVersion.toString(),
          stat.time === undefined ? '' : (new Date(stat.time).toUTCString())
        ]);
      }
    }
    const versionHeader = [
      nodeHeader,
      { alias: 'Repository' },
      { alias: 'Commit Hash' },
      { alias: 'Commit Timestamp' },
      { alias: 'Clean', formatter: function (x) { return x === 'Yes' ? this.style('YES', 'bgGreen', 'black') :  this.style('NO', 'bgRed', 'black'); }  },
      { alias: 'Dingo Version' },
      { alias: 'Stats Time'}
    ];
    const versionFooter = ['Consensus']
      .concat(Array(3).fill(consensusCell))
      .concat([function (cell, columnIndex, rowIndex, rowData) { return ''; }])
      .concat(consensusCell)
      .concat([function (cell, columnIndex, rowIndex, rowData) { return ''; }]);
    s += '  [Version]'
    s += Table(versionHeader, versionFlattened, versionFooter).render();


    // Public Settings info.
    const publicSettingsFlattened = [];
    for (const i in stats) {
      const stat = stats[i];
      if (stat === undefined) {
        publicSettingsFlattened.push(['UNREACHABLE' + i, '', '', '', ''])
      } else {
        publicSettingsFlattened.push([
          i,
          stat.publicSettings.payoutCoordinator.toString(),
          stat.publicSettings.authorityThreshold.toString(),
          stat.publicSettings.authorityNodes.map((x) => `${x.hostname}:${x.port}\\${x.walletAddress}`).join(' '),
          stat.publicSettings.walletAddress
        ]);
      }
    }
    const publicSettingsHeader = [
      nodeHeader,
      { alias: 'Coordinator' },
      { alias: 'Threshold' },
      { alias: 'Authority Nodes', width: 80 },
      { alias: 'Wallet Address' }
    ];
    const publicSettingsFooter = ['Consensus'].concat(Array(publicSettingsHeader.length - 2).fill(consensusCell)).concat([function (cell, columnIndex, rowIndex, rowData) { return ''; }]);
    s += '\n\n  [Public Settings]'
    s += Table(publicSettingsHeader, publicSettingsFlattened, publicSettingsFooter).render();


    // Dingo settings.
    const dingoSettingsFlattened = [];
    for (const i in stats) {
      const stat = stats[i];
      if (stat === undefined) {
        dingoSettingsFlattened.push(['UNREACHABLE' + i, '', '', '', '']);
      } else {
        try {
          dingoSettingsFlattened.push([
            i,
            stat.dingoSettings.changeAddress,
            stat.dingoSettings.changeConfirmations.toString(),
            stat.dingoSettings.depositConfirmations.toString(),
            stat.dingoSettings.taxPayoutAddresses.join(' ')
          ]);
        } catch {
          dingoSettingsFlattened.push([i, '', '', '', '']);
        }
      }
    }
    const dingoSettingsHeader = [
      nodeHeader,
      { alias: 'Change Address' },
      { alias: 'Change Confirmations' },
      { alias: 'Deposit Confirmations' },
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


    // Confirmed deposits.
    const confirmedDepositStatsFlattened = [];
    for (const i in stats) {
      const stat = stats[i];
      if (stat === undefined) {
        confirmedDepositStatsFlattened.push(['UNREACHABLE' + i, '', '', '', '', '']);
      } else {
        try {
          confirmedDepositStatsFlattened.push([
            i,
            stat.confirmedDeposits.count.toString(),
            stat.confirmedDeposits.totalDepositedAmount,
            stat.confirmedDeposits.totalApprovableTax,
            stat.confirmedDeposits.totalApprovedTax,
            stat.confirmedDeposits.remainingApprovableTax
          ]);
        } catch (e) {
          confirmedDepositStatsFlattened.push([i, '', '', '', '', '']);
        }
      }
    }
    const confirmedDepositsHeader = [
      nodeHeader,
      { alias: "Addresses" },
      { alias: "Total Deposited", formatter: satoshiFormatter, width: dingoWidth },
      { alias: "Approvable Tax", formatter: satoshiFormatter, width: dingoWidth },
      { alias: "Approved Tax", formatter: satoshiFormatter, width: dingoWidth },
      { alias: "Remaining Tax", formatter: satoshiFormatter, width: dingoWidth }
    ];
    const confirmedDepositsFooter = ['Consensus'].concat(Array(confirmedDepositsHeader.length - 1).fill(consensusCell));
    s += '\n\n  [Deposits (Confirmed)]';
    s += Table(confirmedDepositsHeader, confirmedDepositStatsFlattened, confirmedDepositsFooter, { truncate: '...' }).render();


    // Unconfirmed deposits.
    const unconfirmedDepositStatsFlattened = [];
    for (const i in stats) {
      const stat = stats[i];
      if (stat === undefined) {
        unconfirmedDepositStatsFlattened.push(['UNREACHABLE' + i, '', '', '', '', '']);
      } else {
        try {
          unconfirmedDepositStatsFlattened.push([
            i,
            stat.unconfirmedDeposits.count.toString(),
            stat.unconfirmedDeposits.totalDepositedAmount,
            stat.unconfirmedDeposits.totalApprovableTax,
            stat.unconfirmedDeposits.totalApprovedTax,
            stat.unconfirmedDeposits.remainingApprovableTax
          ]);
        } catch (e) {
          unconfirmedDepositStatsFlattened.push([i, '', '', '', '', '']);
        }
      }
    }
    const unconfirmedDepositsHeader = [
      nodeHeader,
      { alias: "Addresses" },
      { alias: "Total Deposited", formatter: satoshiFormatter, width: dingoWidth },
      { alias: "Approvable Tax", formatter: satoshiFormatter, width: dingoWidth },
      { alias: "Approved Tax", formatter: satoshiFormatter, width: dingoWidth },
      { alias: "Remaining Tax", formatter: satoshiFormatter, width: dingoWidth }
    ];
    const unconfirmedDepositsFooter = ['Consensus'].concat(Array(unconfirmedDepositsHeader.length - 1).fill(consensusCell));
    s += '\n\n  [Deposits (Unconfirmed)]';
    s += Table(unconfirmedDepositsHeader, unconfirmedDepositStatsFlattened, unconfirmedDepositsFooter, { truncate: '...' }).render();


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
    const confirmedUtxoStatsFlattened = [];
    for (const i in stats) {
      const stat = stats[i];
      if (stat === undefined) {
        confirmedUtxoStatsFlattened.push(['UNREACHABLE' + i, '', '']);
      } else {
        try {
          confirmedUtxoStatsFlattened.push([
            i,
            stat.confirmedUtxos.totalChangeBalance,
            stat.confirmedUtxos.totalDepositsBalance
          ]);
        } catch (e) {
          confirmedUtxoStatsFlattened.push([i, '', '']);
        }
      }
    }
    const confirmedUtxoHeader = [
      nodeHeader,
      { alias: "Change Balance", formatter: satoshiFormatter, width: dingoWidth },
      { alias: "Deposits Balance", formatter: satoshiFormatter, width: dingoWidth },
    ];
    const confirmedUtxoFooter = ['Consensus'].concat(Array(confirmedUtxoHeader.length - 1).fill(consensusCell));
    s += '\n\n  [UTXOs (Confirmed)]';
    s += Table(confirmedUtxoHeader, confirmedUtxoStatsFlattened, confirmedUtxoFooter, { truncate: '...' }).render();


    // UTXOs.
    const unconfirmedUtxoStatsFlattened = [];
    for (const i in stats) {
      const stat = stats[i];
      if (stat === undefined) {
        unconfirmedUtxoStatsFlattened.push(['UNREACHABLE' + i, '', '']);
      } else {
        try {
          unconfirmedUtxoStatsFlattened.push([
            i,
            stat.unconfirmedUtxos.totalChangeBalance,
            stat.unconfirmedUtxos.totalDepositsBalance
          ]);
        } catch (e) {
          unconfirmedUtxoStatsFlattened.push([i, '', '']);
        }
      }
    }
    const unconfirmedUtxoHeader = [
      nodeHeader,
      { alias: "Change Balance", formatter: satoshiFormatter, width: dingoWidth },
      { alias: "Deposits Balance", formatter: satoshiFormatter, width: dingoWidth },
    ];
    const unconfirmedUtxoFooter = ['Consensus'].concat(Array(unconfirmedUtxoHeader.length - 1).fill(consensusCell));
    s += '\n\n  [UTXOs (Unconfirmed)]';
    s += Table(unconfirmedUtxoHeader, unconfirmedUtxoStatsFlattened, unconfirmedUtxoFooter, { truncate: '...' }).render();

    console.log(s);
  }

  async function log(index) {
    const result = await post(`${getAuthorityLink(publicSettings.authorityNodes[parseInt(index)])}/log`,
      await createTimedAndSignedMessage({}));
    console.log(result.log);
  }

  async function syncDatabase(index) {
    console.log('Downloading database...');
    const result = await post(`${getAuthorityLink(publicSettings.authorityNodes[parseInt(index)])}/dumpDatabase`,
      await createTimedAndSignedMessage({}));
    console.log('Overwriting local database...');
    await database.reset(databaseSettings.databasePath, result.sql);
    console.log('Done!');
  }

  async function dingoDoesAHarakiri(index) {
    console.log('Sending suicide signal to nodes...');
    for (const x of (index === undefined ? publicSettings.authorityNodes : [publicSettings.authorityNodes[parseInt(index)]])) {
      process.stdout.write(`  ${getStyledAuthorityLink(x)} ${chalk.bold('->')} `);
      try {
        const result = await post(`${getAuthorityLink(x)}/dingoDoesAHarakiri`, await createTimedAndSignedMessage({}));
        console.log('OK');
      } catch (error) {
        if (error.response) { console.log(getStyledError(error.response.statusCode, error.response.body)); }
        else { console.log(getStyledError(null, error.message)); }
      }
    }
  }



})();

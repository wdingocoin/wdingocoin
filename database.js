const sqlite3 = require('sqlite3')
const util = require('util');
const AsyncLock = require('async-lock');

let db = null;
let dbLock = null;

module.exports = {
  load,
  acquire,
  hasUsedDepositAddresses,
  registerUsedDepositAddresses,
  registerMintDepositAddress,
  getMintDepositAddress,
  getRegisteredMintDepositAddresses,
  registerApprovedWithdrawal,
  hasApprovedWithdrawal,
  getRegisteredApprovedWithdrawals,
  registerPayoutRequest,
  getRegisteredPayoutRequests
};

function load(path) {
  db = new sqlite3.Database(path);
  dbLock = new AsyncLock();
}

function acquire(fn) {
  return dbLock.acquire('db', fn);
}

async function hasUsedDepositAddresses(depositAddresses) {
  return (await util.promisify(db.get.bind(db))(
    `SELECT COUNT(*) from usedDepositAddresses WHERE address IN (${depositAddresses.map(x => '?')})`,
    depositAddresses
  ))['COUNT(*)'] > 0;
}

async function registerUsedDepositAddresses(depositAddresses) {
  const statement = db.prepare('INSERT INTO usedDepositAddresses (address) VALUES (?)');
  for (const depositAddress of depositAddresses) {
    await util.promisify(statement.run.bind(statement))([depositAddress]);
  }
  statement.finalize();
}

function registerMintDepositAddress(mintAddress, depositAddress) {
  return util.promisify(db.run.bind(db))(
    'INSERT INTO mintDepositAddresses (mintAddress, depositAddress) VALUES (?, ?)',
    [mintAddress, depositAddress]);
}

async function getMintDepositAddress(mintAddress) {
  const results = await util.promisify(db.all.bind(db)) (
    'SELECT depositAddress FROM mintDepositAddresses WHERE mintAddress=?',
    [mintAddress]
  );
  if (results.length === 0) {
    return null;
  }
  if (results.length !== 1) {
    throw new Error('Whoever wrote the SQL code is a noob');
  }
  return results[0].depositAddress;
}

function getRegisteredMintDepositAddresses() {
  return util.promisify(db.all.bind(db))(
    `SELECT mintAddress, depositAddress FROM mintDepositAddresses`
  );
}

function registerApprovedWithdrawal(burnAddress, burnIndex) {
  return util.promisify(db.run.bind(db))(
    'INSERT INTO approvedWithdrawals (burnAddress, burnIndex) VALUES (?, ?)',
    [burnAddress, burnIndex]);
}

async function hasApprovedWithdrawal(burnAddress, burnIndex) {
  return (await util.promisify(db.get.bind(db))(
    `SELECT COUNT(*) from approvedWithdrawals WHERE burnAddress=? AND burnIndex=?`,
    [burnAddress, burnIndex]
  ))['COUNT(*)'] > 0;
}

function getRegisteredApprovedWithdrawals() {
  return util.promisify(db.all.bind(db))(
    `SELECT burnAddress, burnIndex FROM approvedWithdrawals`
  );
}

function registerPayoutRequest(requester, requestedAt, data, result) {
  return util.promisify(db.run.bind(db))(
    'INSERT INTO payoutRequests (requester, requestedAt, data, result) VALUES (?, ?, ?, ?)',
    [requester, requestedAt, data, result]);
}

function getRegisteredPayoutRequests() {
  return util.promisify(db.all.bind(db))(
    `SELECT requester, requestedAt, data, result FROM payoutRequests`
  );
}

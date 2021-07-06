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
  registerWithdrawal,
  getWithdrawalStatus,
  getRegisteredWithdrawals,
  registerApprovedTaxPayout,
  getRegisteredApprovedTaxPayouts,
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
    [mintAddress, depositAddress]
  );
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

function registerWithdrawal(burnAddress, burnIndex) {
  return util.promisify(db.run.bind(db))(
    'INSERT INTO withdrawals (burnAddress, burnIndex) VALUES (?, ?)',
    [burnAddress, burnIndex]
  );
}

async function getWithdrawalStatus(burnAddress, burnIndex) {
  const result = await util.promisify(db.all.bind(db))(
    `SELECT status from withdrawals WHERE burnAddress=? AND burnIndex=?`,
    [burnAddress, burnIndex]
  );
  if (result.length === 0) {
    return null;
  }
  if (result.length !== 1) {
    throw new Error('Withdrawal duplicated on (burnAddress, burnIndex)');
  }
  return result[0].status;
}

function getRegisteredWithdrawals(filterStatus) {
  if (filterStatus === undefined) {
    return util.promisify(db.all.bind(db))(
      `SELECT burnAddress, burnIndex, status FROM withdrawals`
    );
  } else {
    return util.promisify(db.all.bind(db))(
      `SELECT burnAddress, burnIndex, status FROM withdrawals WHERE status=?`,
      [filterStatus]
    );
  }
}

function registerApprovedTaxPayout(address, amount, at) {
  return util.promisify(db.run.bind(db))(
    'INSERT INTO approvedTaxPayouts (address, amount, at) VALUES (?, ?, ?)',
    [address, amount, at]
  );
}

function getRegisteredApprovedTaxPayouts() {
  return util.promisify(db.all.bind(db))(
    'SELECT (address, amount, at) FROM approvedTaxPayouts'
  );
}

function registerPayoutRequest(requester, requestedAt, data, result) {
  return util.promisify(db.run.bind(db))(
    'INSERT INTO payoutRequests (requester, requestedAt, data, result) VALUES (?, ?, ?, ?)',
    [requester, requestedAt, data, result]
  );
}

function getRegisteredPayoutRequests(filterResult) {
  if (filterResult === null || filterResult === undefined || filterResult === '') {
    return util.promisify(db.all.bind(db))(
      `SELECT requester, requestedAt, data, result FROM payoutRequests`
    );
  } else {
    return util.promisify(db.all.bind(db))(
      `SELECT requester, requestedAt, data, result FROM payoutRequests WHERE result=?`,
      [filterResult]
    );
  }
}

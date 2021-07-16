"use strict";

const fs = require('fs');
const request = require('request');
const crypto = require('crypto');
const Web3 = require('web3');
const os = require("os");

const DINGO_COOKIE_PATH = '~/.dingocoin/.cookie'.replace('~', os.homedir);
const DINGO_PORT = 34646;

module.exports = {
  toSatoshi,
  fromSatoshi,
  walletPassphrase,
  verifyAddress,
  getTransaction,
  getNewAddress,
  addMultisigAddress,
  importAddress,
  listReceivedByAddress,
  getReceivedAmountByAddress,
  getReceivedAmountByAddresses,
  listUnspent,
  decodeRawTranscation,
  createRawTransaction,
  signRawTransaction,
  verifyAndSignRawTransaction,
  sendRawTranscation
};

function toSatoshi(x) {
  if (x === null || x === undefined || typeof(x) !== 'string' || x === '') {
    throw new Error('Expected string input');
  }
  return (BigInt(Web3.utils.toWei(x, 'gwei')) / 10n).toString();
}

function fromSatoshi(x) {
  if (x === null || x === undefined || typeof(x) !== 'string' || x === '') {
    throw new Error('Expected string input');
  }
  return (Web3.utils.fromWei((BigInt(x) * 10n).toString(), 'gwei')).toString();
}

function getCookie() {
  const data = fs.readFileSync(DINGO_COOKIE_PATH, 'utf-8').split(':');
  return {user: data[0], password: data[1]};
}

async function callRpc(method, params) {
  const cookie = getCookie();
  const options = {
      url: "http://localhost:" + DINGO_PORT.toString(),
      method: "post",
      headers: { "content-type": "text/plain" },
      auth: { user: cookie.user, pass: cookie.password },
      body: JSON.stringify( {"jsonrpc": "1.0", "method": method, "params": params})
  };

  return new Promise((resolve, reject) => {
    request(options, (err, resp, body) => {
      if (err) {
        return reject(err);
      } else {
        const r = JSON.parse(body);
        if (r.error) {
          reject(r.error.message);
        } else {
          resolve(r.result);
        }
      }
    });
  });
}

async function verifyAddress(address) {
  return (await callRpc('validateaddress', [address])).isvalid;
}

function walletPassphrase(passphrase) {
  return callRpc('walletpassphrase', [passphrase, 1000000]);
}

function getTransaction(hash) {
  return callRpc('gettransaction', [hash]);
}

async function getNewAddress() {
  return (await callRpc('validateaddress', [await callRpc('getnewaddress', [])])).pubkey;
}

async function addMultisigAddress(n, individualAddresses) {
  return (await callRpc('addmultisigaddress', [n, individualAddresses]));
}

async function importAddress(address) {
  return callRpc('importaddress', [address, '', false]);
}

async function listReceivedByAddress(confirmations) {
  const data = await callRpc('listreceivedbyaddress', [confirmations, false, true]);
  const dict = {};
  for (const entry of data) {
    dict[entry.address] = entry;
  }
  return dict;
}

async function getReceivedAmountByAddress(confirmations, address) {
  const received = await listReceivedByAddress(confirmations);
  if (!(address in received)) {
    return 0;
  }
  return received[address].amount;
}

async function getReceivedAmountByAddresses(confirmations, addresses) {
  const received = await listReceivedByAddress(confirmations);
  const result = {};
  for (const address of addresses) {
    if (!(address in received)) {
      result[address] = 0;
    } else {
      result[address] = received[address].amount;
    }
  }
  return result;
}

function listUnspent(confirmations, addresses) {
  if (addresses === null || addresses === undefined || addresses.length === 0) {
    return [];
  } else {
    return callRpc('listunspent', [confirmations, 9999999, addresses]);
  }
}

function decodeRawTranscation(hex) {
  return callRpc('decoderawtransaction', [hex]);
}

function createRawTransaction(unspent, payouts, data) {
  const dict = {};
  for (const address of Object.keys(payouts)) {
    dict[address] = payouts[address];
  }

  const hash = crypto.createHash('sha256');
  hash.update(JSON.stringify(data));
  dict['data'] = hash.digest('hex');

  return callRpc('createrawtransaction', [unspent, dict]);
}

function getDataVout(vouts) {
  const entries = vouts.filter((x) => x.scriptPubKey.type === 'nulldata');
  if (entries.length !== 1) {
    return null;
  }
  return entries[0];
}

function getAddressVout(vouts, address) {
  const entries = vouts.filter((x) => (x.scriptPubKey.type === 'scripthash' || x.scriptPubKey.type === 'pubkeyhash') && x.scriptPubKey.addresses.length === 1 && x.scriptPubKey.addresses[0] === address);
  if (entries.length !== 1) {
    return null;
  }
  return entries[0];
}

function signRawTransaction(hex) {
  return callRpc('signrawtransaction', [hex]);
}

async function verifyAndSignRawTransaction(unspent, payouts, data, hex) {
  // TODO: Check inputs? Maybe... Maybe not?
  const tx = await decodeRawTranscation(hex);
  if (tx.vout.length !== Object.keys(payouts).length + 1) { // Additional +1 for data.
    throw new Error('Payouts count mismatch');
  }

  // Check data.
  const hash = crypto.createHash('sha256');
  hash.update(JSON.stringify(data));
  const hashDigested = hash.digest('hex');
  console.log('data');
  console.log(data);
  console.log('hashDigested');
  console.log(hashDigested);
  console.log('scriptPubKeyHex');
  console.log(getDataVout(tx.vout).scriptPubKey.hex);
  if (getDataVout(tx.vout).scriptPubKey.hex.slice(4) !== hashDigested) {
    throw new Error('Payouts data mismatch');
  }

  // TODO: Stop being lazy and write the O(N) solution.
  for (const address of Object.keys(payouts)) {
    if (getAddressVout(tx.vout, address).value.toString() !== payouts[address]) {
      throw new Error('Payouts amount mismatch');
    }
  }

  const result = (await signRawTransaction(hex));
  console.log(result);
  return result.hex;
}

function sendRawTranscation(hex) {
  return callRpc('sendrawtransaction', [hex]);
}

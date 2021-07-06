const fs = require('fs');
const request = require('request');
const crypto = require('crypto');
const Web3 = require('web3');
const os = require("os");

const DINGO_COOKIE_PATH = '~/.dingocoin/.cookie'.replace('~', os.homedir);
const DINGO_PORT = 34646;
const DEPOSIT_CONFIRMATIONS = 0;
const DECIMALS = 8;

module.exports = {
  DEPOSIT_CONFIRMATIONS,
  toSatoshi,
  fromSatoshi,
  walletPassphrase,
  getTransaction,
  getNewAddress,
  addMultisigAddress,
  importAddress,
  listReceivedByAddress,
  getReceivedAmountByAddress,
  getReceivedAmountByAddresses,
  listUnspent,
  createRawTransaction,
  isCorrectRawTransaction,
  decodeRawTranscation,
  signRawTransaction,
  sendRawTranscation
};

function toSatoshi(x) {
  if (typeof(x) !== 'string') {
    throw new Error('Expected string input');
  }
  return (BigInt(Web3.utils.toWei(x, 'gwei')) / 10n).toString();
}

function fromSatoshi(x) {
  if (typeof(x) !== 'string') {
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

async function listReceivedByAddress() {
  const data = await callRpc('listreceivedbyaddress', [DEPOSIT_CONFIRMATIONS, false, true]);
  const dict = {};
  for (const entry of data) {
    dict[entry.address] = entry;
  }
  return dict;
}

async function getReceivedAmountByAddress(address) {
  const received = await listReceivedByAddress();
  if (!(address in received)) {
    return toSatoshi('0');
  }
  return toSatoshi(received[address].amount.toString());
}

async function getReceivedAmountByAddresses(addresses) {
  const received = await listReceivedByAddress();
  const result = {};
  for (const address of addresses) {
    if (!(address in received)) {
      result[address] = toSatoshi('0');
    } else {
      result[address] = toSatoshi(received[address].amount.toString());
    }
  }
  return result;
}

function listUnspent(addresses, changeAddress) {
  return callRpc('listunspent', [0, 9999999, addresses.concat([changeAddress])]);
}

async function createRawTransaction(unspent, changeAddress, address, amount, fee, data) {
  const unspentTotal = unspent.reduce((a, b) => a + BigInt(toSatoshi(b.amount.toString())), BigInt(0));
  const change = unspentTotal - BigInt(amount);
  if (change < 0) {
    throw new Error('Insufficient funds');
  }

  const amountAfterFee = BigInt(amount) - BigInt(toSatoshi(fee)); // Fee is subtracted from amount.
  if (amountAfterFee < 0) {
    throw new Error('Insufficient amount for fee');
  }

  const taxAmount = amountAfterFee / 100n;
  const amountAfterFeeAndTax = amountAfterFee - taxAmount;

  const hash = crypto.createHash('sha256');
  hash.update(JSON.stringify(data));

  const dict = {};
  dict['data'] = hash.digest('hex');
  dict[address] = fromSatoshi(amountAfterFeeAndTax.toString());
  dict[changeAddress] = fromSatoshi((change + taxAmount).toString());
  return callRpc('createrawtransaction', [unspent, dict]);
}

async function isCorrectRawTransaction(unspent, changeAddress, address, amount, fee, data, hex) {
  // Verify structure.
  const transaction = await decodeRawTranscation(hex);
  if (transaction.vout.length !== 3) {
    return false;
  }
  const dataOuts = transaction.vout.filter((x) => x.scriptPubKey.type === 'nulldata');
  const destinationOuts = transaction.vout.filter((x) => x.scriptPubKey.type in ['scripthash', 'pubkeyhash'] && x.scriptPubKey.addresses.length === 1 && x.scriptPubKey.addresses[0] === address);
  const changeOuts = transaction.vout.filter((x) => x.scriptPubKey.type === ['scripthash', 'pubkeyhash'] && x.scriptPubKey.addresses.length === 1 && x.scriptPubKey.addresses[0] === changeAddress);
  if (dataOuts.length !== 1 || destinationOuts.length !== 1 || changeOuts.length !== 1) {
    return false;
  }
  const dataOut = dataOuts[0];
  const destinationOut = destinationOuts[0];
  const changeOut = changeOuts[0];

  // Verify hash.
  const hash = crypto.createHash('sha256');
  hash.update(JSON.stringify(data));
  if (dataOut.scriptPubKey.hex !== hash.digest('hex')) {
    return false;
  }

  // Verify amount.
  const unspentTotal = unspent.reduce((a, b) => a + BigInt(toSatoshi(b.amount)), BigInt(0));
  const change = unspentTotal - BigInt(amount);
  if (change <= 0) {
    throw new Error('Insufficient funds');
  }
  const amountAfterFee = BigInt(amount) - BigInt(toSatoshi(f));
  if (amountAfterFee < 0) {
    throw new Error('Insufficient amount for fee');
  }
  const taxAmount = amountAfterFee / 100n;
  const amountAfterFeeAndTax = amountAfterFee - taxAmount;
  if (toSatoshi(destinationOut.value) !== amountAfterFeeAndTax.toString()) {
    return false;
  }
  if (toSatoshi(changeOut.value) !== (change + taxAmount).toString()) {
    return false;
  }

  return true;
}

function decodeRawTranscation(hex) {
  return callRpc('decoderawtransaction', [hex]);
}

function signRawTransaction(hex) {
  return callRpc('signrawtransaction', [hex]);
}

function sendRawTranscation(hex) {
  return callRpc('sendrawtransaction', [hex]);
}

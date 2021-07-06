const fs = require('fs');
const request = require('request');
const crypto = require('crypto');
const Web3 = require('web3');
const os = require("os");

const DINGO_COOKIE_PATH = '~/.dingocoin/.cookie'.replace('~', os.homedir);
const DINGO_PORT = 34646;
const DEPOSIT_CONFIRMATIONS = 5;

module.exports = {
  DEPOSIT_CONFIRMATIONS,
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
  createRawTransaction,
  verifyRawTransaction,
  createPayoutRawTransaction,
  verifyPayoutRawTransaction,
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

function createRawTransaction(unspent, changeAddress, address, amount, fee, data) {
  const unspentTotal = unspent.reduce((a, b) => a + BigInt(toSatoshi(b.amount.toString())), BigInt(0));
  const change = unspentTotal - BigInt(amount);
  if (change < 0) {
    console.log(unspentTotal, amount);
    throw new Error('Insufficient funds');
  }

  const taxAmount = BigInt(amount) / 100n;
  const amountAfterTax = BigInt(amount) - taxAmount;
  const amountAfterTaxAndFee = amountAfterTax - BigInt(toSatoshi(fee));
  if (amountAfterTaxAndFee < 0) {
    throw new Error('Insufficient amount for tax and fee');
  }

  const hash = crypto.createHash('sha256');
  hash.update(JSON.stringify(data));

  const dict = {};
  dict['data'] = hash.digest('hex');
  dict[address] = fromSatoshi(amountAfterTaxAndFee.toString());
  dict[changeAddress] = fromSatoshi((change + taxAmount).toString());
  return callRpc('createrawtransaction', [unspent, dict]);
}

function getDataVout(vouts) {
  const entries = vouts.filter((x) => x.scriptPubKey.type === 'nulldata');
  if (entries.length !== 1) {
    throw new Error('Data unfound or invalid in vouts');
  }
  return entries[0];
}

function getAddressVout(vouts, address) {
  const entries = vouts.filter((x) => (x.scriptPubKey.type === 'scripthash' || x.scriptPubKey.type === 'pubkeyhash') && x.scriptPubKey.addresses.length === 1 && x.scriptPubKey.addresses[0] === address);
  if (entries.length !== 1) {
    throw new Error('Address unfound or invalid in vouts');
  }
  return entries[0];
}

async function verifyRawTransaction(unspent, changeAddress, address, amount, fee, data, hex) {
  // Verify structure.
  const transaction = await decodeRawTranscation(hex);
  if (transaction.vout.length !== 3) {
    throw new Error('Incorrect transaction structure');
  }
  const dataOut = getDataVout(transaction.vout);
  const destinationOut = getAddressVout(transaction.vout, address);
  const changeOut = getAddressVout(transaction.vout, changeAddress);

  // Verify hash.
  const hash = crypto.createHash('sha256');
  hash.update(JSON.stringify(data));
  if (dataOut.scriptPubKey.hex !== hash.digest('hex')) {
    throw new Error('Incorrect transaction data');
  }

  // Verify amount.
  const unspentTotal = unspent.reduce((a, b) => a + BigInt(toSatoshi(b.amount)), BigInt(0));
  const change = unspentTotal - BigInt(amount);
  if (change <= 0) {
    throw new Error('Insufficient funds');
  }

  const taxAmount = BigInt(amount) / 100n;
  const amountAfterTax = BigInt(amount) - taxAmount;
  const amountAfterTaxAndFee = amountAfterTax - BigInt(toSatoshi(fee));
  if (amountAfterTaxAndFee < 0) {
    throw new Error('Insufficient amount for tax and fee');
  }

  if (toSatoshi(destinationOut.value.toString()) !== amountAfterTaxAndFee.toString()) {
    throw new Error('Incorrect transaction amount');
  }
  if (toSatoshi(changeOut.value.toString()) !== (change + taxAmount).toString()) {
    throw new Error('Incorrect transaction amount');
  }
}

function createPayoutRawTransaction(unspent, changeAddress, addresses, amount, fee) {
  const unspentTotal = unspent.reduce((a, b) => a + BigInt(toSatoshi(b.amount.toString())), BigInt(0));
  const change = unspentTotal - BigInt(amount);
  if (change < 0) {
    throw new Error('Insufficient funds');
  }
  const amountAfterFee = BigInt(amount) - BigInt(toSatoshi(fee)); // Fee is subtracted from amount.
  if (amountAfterFee < 0) {
    throw new Error('Insufficient amount for fee');
  }
  // Round down.
  const amountPerPayee = amountAfterFee / BigInt(addresses.length);
  const spare = amountAfterFee - (amountPerPayee * BigInt(addresses.length));

  const dict = {};
  for (const address of addresses) {
    dict[address] = fromSatoshi(amountPerPayee.toString());
  }
  dict[changeAddress] = fromSatoshi((change + spare).toString());
  return callRpc('createrawtransaction', [unspent, dict]);
}

async function verifyPayoutRawTransaction(unspent, changeAddress, addresses, amount, fee, hex) {
  const unspentTotal = unspent.reduce((a, b) => a + BigInt(toSatoshi(b.amount.toString())), BigInt(0));
  const change = unspentTotal - BigInt(amount);
  if (change < 0) {
    throw new Error('Insufficient funds');
  }
  const amountAfterFee = BigInt(amount) - BigInt(toSatoshi(fee)); // Fee is subtracted from amount.
  if (amountAfterFee < 0) {
    throw new Error('Insufficient amount for fee');
  }
  // Round down.
  const amountPerPayee = amountAfterFee / BigInt(addresses.length);
  const spare = amountAfterFee - (amountPerPayee * BigInt(addresses.length));

  // Verify structure.
  const transaction = await decodeRawTranscation(hex);
  if (transaction.vout.length !== addresses.length + 1) {
    throw new ('Incorrect payout structure');
  }
  for (const i in transaction.vout) {
    if (i < transaction.vout.length - 1) {
      const vout = getAddressVout(transaction.vout, addresses[i]);
      if (toSatoshi(vout.value.toString()) !== amountPerPayee.toString()) {
        throw new Error('Incorrect payout amount');
      }
    } else {
      const vout = getAddressVout(transaction.vout, changeAddress);
      if (toSatoshi(vout.value.toString()) !== (change + spare).toString()) {
        throw new Error('Incorrect payout amount');
      }
    }
  }
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

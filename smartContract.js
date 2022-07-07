"use strict";

const Web3 = require('web3');
const Cache = require('async-disk-cache');

const cache = new Cache('wdingocoin-bsc-burn');
let web3 = null;
let account = null;
let contract = null;

module.exports = {
  createSignedMessage,
  validateSignedMessage,
  validateSignedMessageOne,
  createAccount,
  isAddress,
  loadProvider,
  loadContract,
  loadAccount,
  getAccountAddress,
  sign,
  verify,
  getAuthorityAddresses,
  getAuthorityThreshold,
  getMinBurnAmount,
  signConfigure,
  getMintNonce,
  getMintHistory,
  signMintTransaction,
  getBurnHistory,
  getBurnHistoryMultiple
};

function isSpecified(x) {
  return x !== undefined && x !== null;
}

function createSignedMessage(data) {
  return {
    data: data,
    signature: sign(JSON.stringify(data)).signature
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
  if (!verify(JSON.stringify(message.data), message.signature, walletAddress)) {
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
    x => verify(JSON.stringify(message.data), message.signature, x) ? 1 : 0);
  if (verifications.reduce((a, b) => a + b, 0) !== 1) {
    throw new Error('Authority verification failed');
  }
  if (discard) {
    return message.data;
  } else {
    return message;
  }
}

function createAccount() {
  return web3.eth.accounts.create();
}

function isAddress(address) {
  return web3.utils.isAddress(address);
}

function loadProvider(provider) {
  web3 = new Web3(provider);
}

function loadContract(contractAbi, contractAddress) {
  contract = new web3.eth.Contract(contractAbi, contractAddress);
}

function loadAccount(privateKey) {
  account = web3.eth.accounts.privateKeyToAccount(privateKey);
}

function getAccountAddress() {
  return account.address;
}

function sign(message) {
  return web3.eth.accounts.sign(message, account.privateKey);
}

function verify(message, signature, accountAddress) {
  return web3.eth.accounts.recover(message, signature) === accountAddress;
}

function getAuthorityAddresses() {
  return contract.methods.authorityAddresses().call();
}

function getAuthorityThreshold() {
  return contract.methods.authorityThreshold().call();
}

function getMinBurnAmount() {
  return contract.methods.minBurnAmount().call();
}

function signConfigure(chainId, nonce, newAuthorityAddresses, newAuthorityThreshold, newMinBurnAmount) {
  const encoded = web3.eth.abi.encodeParameters(
    ['uint256', 'uint256', 'address[]', 'uint8', 'uint256'],
    [chainId, nonce, newAuthorityAddresses, newAuthorityThreshold, newMinBurnAmount]
  );
  return web3.eth.accounts.sign(web3.utils.keccak256(encoded), account.privateKey);
}

function getMintNonce(address) {
  return contract.methods.mintNonce(address).call();
}

async function getMintHistory(address, depositAddress) {
  const result = await contract.methods.mintHistory(address, depositAddress).call();
  return { mintNonce: result['0'], mintedAmount: result['1'] }
}

function signMintTransaction(chainId, mintAddress, nonce, depositAddress, amount) {
  const encoded = web3.eth.abi.encodeParameters(
    ['uint256', 'address', 'uint256', 'string', 'uint256'],
    [chainId, mintAddress, nonce, depositAddress, amount]
  );
  return web3.eth.accounts.sign(web3.utils.keccak256(encoded), account.privateKey);
}

async function getBurnHistory(burnAddress, burnIndex) {
  if (burnIndex === undefined) {
    const burnHistory = await contract.methods.burnHistory(burnAddress).call();
    for (const i in burnHistory["0"]) {
      await cache.set(`${burnAddress}|${burnIndex}`, JSON.stringify({ burnDestination: burnHistory["0"][i], burnAmount: burnHistory["1"][i] }));
    }
    return burnHistory["0"].map((x, i) => {
      return { burnDestination: x, burnAmount: burnHistory["1"][i] };
    });
  } else {
    if (await cache.has(`${burnAddress}|${burnIndex}`)) {
      return JSON.parse((await cache.get(`${burnAddress}|${burnIndex}`)).value);
    } else {
      const burnHistory = (await contract.methods.burnHistory(burnAddress, burnIndex).call());
      await cache.set(`${burnAddress}|${burnIndex}`, JSON.stringify({ burnDestination: burnHistory["0"], burnAmount: burnHistory["1"] }));
      return { burnDestination: burnHistory["0"], burnAmount: burnHistory["1"] };
    }
  }
}

async function getBurnHistoryMultiple(burnAddresses, burnIndexes) {
  let result = [];
  for (const i in burnAddresses) {
    result.push(await getBurnHistory(burnAddresses[i], burnIndexes[i]));
  }
  return result;
}

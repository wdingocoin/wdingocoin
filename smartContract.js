const Web3 = require('web3');

let web3 = null;
let account = null;
let contract = null;

module.exports = {
  createAccount,
  isAddress,
  loadProvider,
  loadContract,
  loadAccount,
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

function signConfigure(newAuthorityAddresses, newAuthorityThreshold, newMinBurnAmount) {
  const encoded = web3.eth.abi.encodeParameters(
    ['address[]', 'uint8', 'uint256'],
    [newAuthorityAddresses, newAuthorityThreshold, newMinBurnAmount]
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

function signMintTransaction(mintAddress, nonce, depositAddress, amount) {
  const encoded = web3.eth.abi.encodeParameters(
    ['address', 'uint256', 'string', 'uint256'],
    [mintAddress, nonce, depositAddress, amount]
  );
  return web3.eth.accounts.sign(web3.utils.keccak256(encoded), account.privateKey);
}

async function getBurnHistory(burnAddress, burnIndex) {
  if (burnIndex === undefined) {
    const burnHistory = await contract.methods.burnHistory(burnAddress).call();
    return burnHistory["0"].map((x, i) => {
      return { burnDestination: x, burnAmount: burnHistory["1"][i] };
    });
  } else {
    const burnHistory = (await contract.methods.burnHistory(burnAddress, burnIndex).call());
    return { burnDestination: burnHistory["0"], burnAmount: burnHistory["1"] };
  }
}

async function getBurnHistoryMultiple(burnAddresses, burnIndexes) {
  const result = await contract.methods.burnHistoryMultiple(burnAddresses, burnIndexes).call();
  return { burnDestinations: result["0"], burnAmounts: result["1"] };
}

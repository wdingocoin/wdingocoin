DROP TABLE IF EXISTS usedDepositAddresses;
CREATE TABLE IF NOT EXISTS usedDepositAddresses (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  address TEXT NOT NULL UNIQUE
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_usedDepositAddresses_address ON usedDepositAddresses (address);

DROP TABLE IF EXISTS mintDepositAddresses;
CREATE TABLE IF NOT EXISTS mintDepositAddresses (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  mintAddress TEXT NOT NULL UNIQUE,
  depositAddress TEXT NOT NULL UNIQUE
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_mintDepositAddresses_mintAddress ON mintDepositAddresses (mintAddress);
CREATE UNIQUE INDEX IF NOT EXISTS idx_mintDepositAddresses_depositAddress ON mintDepositAddresses (depositAddress);

DROP TABLE IF EXISTS approvedWithdrawals;
CREATE TABLE IF NOT EXISTS approvedWithdrawals (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  burnAddress TEXT NOT NULL,
  burnIndex INTEGER NOT NULL
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_approvedWithdrawals_burnAddress_burnIndex ON approvedWithdrawals (burnAddress, burnIndex);

DROP TABLE IF EXISTS payoutRequests;
CREATE TABLE IF EXISTS payoutRequests (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  requester TEXT NOT NULL,
  requestedAt TEXT NOT NULL,
  data TEXT NOT NULL,
  result TEXT NOT NULL
);

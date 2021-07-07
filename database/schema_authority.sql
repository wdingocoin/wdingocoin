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
  depositAddress TEXT NOT NULL UNIQUE,
  approvedTax TEXT NOT NULL DEFAULT "0"
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_mintDepositAddresses_mintAddress ON mintDepositAddresses (mintAddress);
CREATE UNIQUE INDEX IF NOT EXISTS idx_mintDepositAddresses_depositAddress ON mintDepositAddresses (depositAddress);

DROP TABLE IF EXISTS withdrawals;
CREATE TABLE IF NOT EXISTS withdrawals (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  burnAddress TEXT NOT NULL,
  burnIndex INTEGER NOT NULL,
  approvedAmount TEXT NOT NULL DEFAULT "0",
  approvedTax TEXT NOT NULL DEFAULT "0"
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_withdrawals_burnAddress_burnIndex ON withdrawals (burnAddress, burnIndex);

DROP TABLE IF EXISTS approvedPayouts;
CREATE TABLE IF NOT EXISTS approvedPayouts (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  address TEXT NOT NULL,
  amount TEXT NOT NULL,
  at TEXT NOT NULL,
  info TEXT
);
CREATE INDEX IF NOT EXISTS idx_approvedPayouts_address ON approvedPayouts (address);

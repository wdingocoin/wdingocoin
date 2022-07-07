"use strict";

const CoinpaprikaAPI = require('@coinpaprika/api-nodejs-client');
const dingo = require('./dingo');
const AsyncLock = require('async-lock');
const express = require('express');
const cors = require('cors');
const graphqlGot = require('graphql-got');
const got = require('got');

(async function main() {

  const lock = new AsyncLock();
  const acquire = function (fn) {
    return lock.acquire('lock', fn);
  };

  let dingoStats = null;
  let marketStats = null;

  const refresh = async function () { 
    // Get dingo stats.
    dingoStats = await dingo.getTxOutSetInfo();

    const currentTime = new Date();
    const startTime = new Date();
    startTime.setDate(startTime.getDate() - 1);

    // Get CoinPaprika data.
    const coinPaprikaClient = new CoinpaprikaAPI();
    const coinPaprikaTicker = await coinPaprikaClient.getTicker({ coinId: "dingo-dingocoin" });
    const coinPaprikaPrice = parseFloat(coinPaprikaTicker['price_usd']);
    const coinPaprikaVolume = parseFloat(coinPaprikaTicker['volume_24h_usd']);
    console.log(`Coin Paprika Volume = ${coinPaprikaVolume}`);
    console.log(`Coin Paprika Price = ${coinPaprikaPrice}`);

    // Get pancakeswap volume data.
    const query = `
        {
          ethereum(network: bsc) {
            dexTrades(
              time: {since: "${startTime.toISOString()}"}
              exchangeName: {is: "Pancake v2"}
              baseCurrency: {is: "0x9b208b117b2c4f76c1534b6f006b033220a681a4"}
            ) {
              tradeAmount(in: USD)
            }
          }
        }`;
    const pancakeVolumeData = await graphqlGot('https://graphql.bitquery.io', {query});
    const pancakeVolume = parseFloat(pancakeVolumeData.body.ethereum.dexTrades[0].tradeAmount); // In USD.
    console.log(`Pancake Volume = ${pancakeVolume}`);

    // Get pancakeswap price data.
    const pancakePriceData = JSON.parse((await got.get('https://api.pancakeswap.info/api/v2/tokens/0x9b208b117b2c4f76c1534b6f006b033220a681a4', { timeout: { request: 5000 } })).body);
    const pancakePrice = parseFloat(pancakePriceData.data.price); // In USD.
    console.log(`Pancake Price = ${pancakePrice}`);

    const volume = coinPaprikaVolume + pancakeVolume;
    const price = (coinPaprikaVolume * coinPaprikaPrice + pancakeVolume * pancakePrice) / volume;
    const cap = price * dingoStats.total_amount;

    marketStats = { volume: volume, price: price, cap: cap };
  };

  await acquire(async () => await refresh().catch(console.log));
  setInterval(async () => {
    await acquire(async () => await refresh().catch(console.log));
  }, 1000 * 60);

  const app = express();
  app.use(cors());
  app.use(express.json());


  app.get('/dingo', (req, res) => {
    res.send(dingoStats);
  });
	
  app.get('/market', (req, res) => {
    res.send(marketStats);
  });

  app.use((err, req, res, _next) => {
    if (err instanceof IPBlockedError) {
      res.status(401).send(`Access forbidden from ${req.header('x-forwarded-for')}`);
    } else {
      res.status(err.status || 500).send('Internal server error');
    }
  })

  app.listen(8445, () => {
    console.log(`Started on port 8445`);
  });

})();

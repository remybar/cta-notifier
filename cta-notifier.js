const dotenv = require("dotenv");
dotenv.config();

const fs = require("fs");
const express = require("express");
const winston = require("winston");
const Big = require("big.js");
const notifier = require("node-notifier");
const path = require("path");

const { ImmutableX, Config } = require("@imtbl/core-sdk");

/**
 * CONSTANTS
 */
const PORT = process.env.PORT || 12345;
const CHECK_PRICES = process.env.CHECK_PRICES || true;
const REFRESH_PERIOD_IN_MS = process.env.REFRESH_PERIOD_IN_MS || 5 * 1000;
const TOKEN_ADDRESS = process.env.TOKEN_ADDRESS || "";
const IMX_CONFIG = process.env.IMX_PRODUCTION
  ? Config.PRODUCTION
  : Config.SANDBOX;

/**
 * Get token information based on its current name
 */
const TOKEN_INFO = new Map([
  [
    "USDC",
    {
      type: "ERC20",
      decimals: 6,
      address: "0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48",
    },
  ],
  [
    "ETH",
    {
      type: "ETH",
      decimals: 18,
      address: "NOT_USED",
    },
  ],
]);

/**
 * VARIABLES
 */
const loggerFormat = winston.format.printf(
  ({ level, message, _, timestamp }) => {
    return `${timestamp} ${level}: ${message}`;
  }
);
const logger = winston.createLogger({
  level: process.env.DEBUG ? "debug" : "info",
  format: winston.format.combine(winston.format.timestamp(), loggerFormat),
  transports: [
    new winston.transports.Console(),
    new winston.transports.File({ filename: "error.log", level: "error" }),
    new winston.transports.File({ filename: "output.log" }),
  ],
});
const client = new ImmutableX(IMX_CONFIG);
const app = express();

let assets;
let lastCursor;

/**
 * FUNCTIONS
 */

const getTokenName = (order) => {
  if (order?.buy?.type === "ETH") return "ETH";

  const buy = order?.buy;
  for (const [tokenName, tokenInfo] of TOKEN_INFO) {
    if (
      buy?.type === tokenInfo.type &&
      buy?.data?.token_address === tokenInfo.address
    ) {
      return tokenName;
    }
  }
};

/**
 *
 */
const toHumanAmount = (rawAmount, decimals) => {
  return Big(rawAmount).div(Big(10).pow(decimals)).toNumber();
};

/**
 * Build a key from input asset attributes, that will be used in a map to identify the asset.
 * @param attributes
 */
const getAssetKeyFromAttributes = (attributes) => {
  // As there is no information about the card in the offer, just use the url to
  // match the card (foil are not managed :/)
  return attributes.image_filename;
};

/**
 * Build a key from read order, that will be used in a map to identify the asset.
 * @param attributes
 */
const getAssetKeyFromOrder = (order) => {
  const url = order?.sell?.data?.properties?.image_url;
  return url.substring(url.lastIndexOf("/") + 1);
};

/**
 * Prepare a price structure to be able to compare with order prices.
 */
const preparePrice = (price) => {
  const { type, address, _ } = TOKEN_INFO.get(price.token);
  return {
    name: price.token,
    type,
    address,
    value: price.value,
  };
};

/**
 * Prepare asset structure to be able to compare with order data.
 */
const prepareAsset = (asset) => {
  return {
    name: asset.name,
    target_prices: asset.max_prices.map((p) => preparePrice(p)),
  };
};

/**
 * Load a list of assets to buy on the IMX marketplace.
 */
const loadAssets = async () => {
  fs.readFile("assets.json", (err, data) => {
    if (err) throw err;

    const readAssets = JSON.parse(data).assets;
    assets = new Map(
      readAssets.map((a) => [getAssetKeyFromAttributes(a), prepareAsset(a)])
    );

    logger.debug("input assets loaded!");
  });
};

/**
 * Compute reading filters to send to IMX to
 * read active orders.
 */
const getReadFilters = ({ cursor }) => {
  // TODO: adjust read filters

  return {
    status: "active",
    sellTokenAddress: TOKEN_ADDRESS, // the NFT token address we want to build
    cursor,
  };
};

/**
 * Read orders from the collection.
 * @return a list of new orders.
 */
const readOrders = async () => {
  const readFilters = getReadFilters({ cursor: lastCursor });
  const { result: orders, cursor: _cursor } = await client.listOrders(
    readFilters
  );
  lastCursor = _cursor;

  if (process.env.DEBUG) {
    fs.writeFileSync(
      `debug/${new Date().toISOString()}-orders.json`,
      JSON.stringify(orders, null, 2)
    );
  }

  return orders;
};

/**
 * Get the order price
 */
const getOrderPrice = (data) =>
  toHumanAmount(data?.quantity_with_fees, data?.decimals);

/**
 * Check if the order price match with the asset target price (several tokens)
 */
const matchPrice = (asset, order) => {
  const buy = order?.buy;
  const price = getOrderPrice(buy.data);
  const target_price = asset.target_prices.filter((p) =>
    buy?.type === "ETH"
      ? p.type === "ETH"
      : buy?.type === p.type && buy?.data?.token_address === p.address
  );
  return target_price.length > 0 && target_price[0].value >= price;
};

/**
 * Match orders against assets to buy to extract
 * interesting orders.
 * @param {*} orders orders read from the marketplace.
 * @returns interesting orders.
 */
const matchOrders = async (orders) => {
  return orders.filter((order) => {
    const key = getAssetKeyFromOrder(order);
    const asset = assets.get(key);
    return asset && (!CHECK_PRICES || matchPrice(asset, order));
  });
};

/**
 * Notify interesting orders.
 * @param matchedOrders interesting orders.
 */
const notifyMatchedOrders = async (matchedOrders) => {
  for (order of matchedOrders) {
    const assetName = order?.sell?.data?.properties?.name;
    const tokenName = getTokenName(order);
    const amount = getOrderPrice(order?.buy?.data);
    const url = `https://market.immutable.com/collections/${TOKEN_ADDRESS}/assets/${order.sell.data.token_id}`;

    notifier.notify({
      title: assetName,
      open: url,
      message: `${amount} ${tokenName}`,
      sound: true,
    });
  }
};

/**
 * Initializing...
 */
const initialize = async () => {
  logger.debug("initializing...");
  await loadAssets();
};
/**
 * Updating ...
 */
const update = async () => {
  if (!assets) {
    logger.debug("not ready");
    return;
  }

  logger.debug("reading orders...");
  const orders = await readOrders();
  const matchedOrders = await matchOrders(orders);
  await notifyMatchedOrders(matchedOrders);
};

/**
 * Express app structure.
 */
setImmediate(async () => {
  await initialize();
  await update();
});

setInterval(async () => {
  await update();
}, REFRESH_PERIOD_IN_MS);

app.listen(PORT, () => {
  logger.info(`live on ${PORT} ...`);
});

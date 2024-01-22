# price_oracle_beacon
Gora Sponsored Price Beacon

This repo contains an end to end example of calling the Gora price oracle from a deployed smart contract.

To understand how the example is setup, begin with the [Gora Documentation](https://github.com/GoraNetwork/.github/wiki/Gora-Decentralized-Oracle-Documentation).

##price_pair.py

This file contains all the code a smart contract needs to make calls to any price endpoint, including the deposit of gas fees. Results from the oracle are stored in Boxes. Use `build.py` to compile the file. 

##utils.ts

This file contains Typescript functinality that allows a front end to read (and trigger) smart contract calls as needed. 

## NOTE:

In other to use the code provided in this repo, you have to note the following.

1. You are to change the `GORA_CONTRACT_ID` and `GORA_TOKEN_ID` located in the `utils.consts` file., to the Gora token/app id you are working with.

2. In other to get an over view on how things work please refer to the `demo.py` file to see how the price oracle is utilized. Example of the response from the `demo.py` file:

```
Dumping PricePair to c:.........\price_oracle_beacon\artifacts
PRICE ORACLE APP ID : 1221 
APP ADDRESS : LRP2Q2NWLKWHM3VZSNBOCDHYWPQJQKPLUIMWVAD6XUULMSUNIK46LL7FX4
CREATING A BOX FOR THE REQUEST PARAMS
CREATING A BOX TO HOLD THE ORACLE PRICE RESULT
STAKING SOME GORA AND ALGO TO THE GORA CONTRACT......
STAKED GORA AND ALGO TO THE GORA CONTRACT
FETCHING GORA PRICE DATA FOR b'BTC/USD'
GORA PRICE DATA FETCHED
ORACLE PRICE DATA FOR b'BTC/USD' :: 34667.779
```
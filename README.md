# price_oracle_beacon
Gora Sponsored Price Beacon

This repo contains an end to end example of calling the Gora price oracle from a deployed smart contract.

To understand how the example is setup, begin with the [Gora Documentation](https://github.com/GoraNetwork/.github/wiki/Gora-Decentralized-Oracle-Documentation).

##price_pair.py

This file contains all the code a smart contract needs to make calls to any price endpoint, including the deposit of gas fees. Results from the oracle are stored in Boxes. Use `build.py` to compile the file. 

##utils.ts

This file contains Typescript functinality that allows a front end to read (and trigger) smart contract calls as needed. 

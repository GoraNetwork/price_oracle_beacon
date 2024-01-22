To build the stake the delegator app for production use

python stakedelegator.py {GORA_TOKEN_ID: <GORATOKENID>, MAIN_APP_ID: <MAIN_APP_ID>}

followed by using beaker-ts to generate a client that's useful for webapp

npx tsx ./node_modules/beaker-ts/src/beaker.ts generate ./assets/stake_delegator/artifacts/application.json ./assets/stake_delegator/artifacts/

When opting in, if you are staking through a vesting app, you will need to provide this id. If you are not, the input will need to be set to 0.

#This app was developed under beaker-pyteal==0.5.4 (before 1.0 came out :( )
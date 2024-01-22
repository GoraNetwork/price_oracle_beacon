To build the stake the vesting app for production use

python build.py

followed by using beaker-ts to generate a client that's useful for webapp

npx tsx ./node_modules/beaker-ts/src/beaker.ts generate ./assets/vesting/artifacts/application.json ./assets/vesting/artifacts/

#This app was developed under beaker-pyteal==0.5.4 (before 1.0 came out :( )

It is by design that claiming vested tokens (via the method claim_vesting) on behalf of a vester can be executed by any one at any time:
  a. Allowing claim_vesting() to be used by anyone to claim tokens on behalf of the vestee was an intentional design choice to allow flexibility in a variety of situations.
  b. Allowing claim_vesting() to be called by anyone other than the vestee does not have negative effects to the vestee.
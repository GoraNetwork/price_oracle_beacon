import { 
  ABIMethod,
  ABIUintType,
  Account,
  Algodv2,
  LogicSigAccount,
  decodeAddress,
  encodeUint64,
  generateAccount,
  getApplicationAddress,
  getMethodByName,
  makeAssetTransferTxnWithSuggestedParamsFromObject,
  makeBasicAccountTransactionSigner,
  makePaymentTxnWithSuggestedParamsFromObject,
} from "algosdk";
import * as fs from "fs";
import path from "path";
import * as bkr from "beaker-ts";

import { SandboxAccount } from "beaker-ts/src/sandbox/accounts";
import { Vesting } from "../artifacts/vesting_client";
import { compileBeaker, sendGenericAsset, sendGenericPayment } from "../../../utils/beaker_test_utils";
import { getVestings } from "../vestingUtils";
import { getGlobal as delegatorGetGlobal, getLocal as delegatorGetLocal, deploy_delegator } from "../../stake_delegator/delegatorUtils";
import {VestingKey} from "../abi_structures";
import { sha512_256 } from "js-sha512";
import { StakeDelegator } from "../../stake_delegator/artifacts/stakedelegator_client";
import { AccountGenerator, VotingTestState, beforeEachVotingTest } from "../../../test/e2e/vote/voting.helpers";
import accounts from "../../../test/test_fixtures/accounts.json";
import { globalZeroAddress } from "@algo-builder/algob";
import { fundAccount } from "algotest";

async function sleep_rounds(rounds:number, acc:SandboxAccount){
  for(let i = 0; i < rounds; i++)
  {
    await sendGenericPayment(acc.signer, acc.addr, acc.addr, 0);
  }
}

describe("Web app file generation tests", () => {
  let sandboxAccount: SandboxAccount;
  let sandboxAppClient: Vesting;
  let appId: number;
  let testAsset: number;
  let appAddress: string;
  let users : Account[];
  let delegator_app_id: number;
  let delegator_app_addr: string;
  let accountGenerator: AccountGenerator;
  let testState: VotingTestState;
  let mainAppAddress: string;
  let mainAppId: number;
  let goracle_timelock: number;
  let algodClient: Algodv2;
  let testParameters: any;
  let TIME_LOCK: number;
  let votingAppId: number;
  let destinationAppId: number;
  let user: Account;
  let current_request_round: any;
  let network: number;
  let voteVerifyLsig: LogicSigAccount;
  let goraRequestFee: number;
  let algoRequestFee: number;
  let requestBoxCost: number;
  let VOTE_REFILL_THRESHOLD: number;
  let VOTE_REFILL_AMOUNT: number;
  let optInMethod: ABIMethod;
  let testSetupInfo:any;
  let delegatorInfo: any;
  let appCreateResults: bkr.CreateResult;

  function getVestingClient(
    user: Account,
    algodClient: Algodv2,
    approvalProgram: string,
    clearProgram: string
  ){
    const client = new Vesting(
      {
        client: algodClient,
        signer: makeBasicAccountTransactionSigner(user),
        sender: user.addr,
        appId: appId
      }
    );
    client.approvalProgram = approvalProgram;
    client.clearProgram = clearProgram;
    return client;
  }
  
  function sleep(ms: number) {
    return new Promise( resolve => setTimeout(resolve, ms) );
  }

  function modifyAccount(account:Account){
    const modifiedUser:any = {};
    modifiedUser.addr = account.addr;
    modifiedUser.sk = Buffer.from(account.sk).toString("base64");
    return modifiedUser;
  }

  beforeEach(async () => {
    accountGenerator = new AccountGenerator(accounts);
    testState = await beforeEachVotingTest(accountGenerator);
    const NUM_USERS = 10;

    // flatten the testState object
    ({ current_request_round, votingAppId, mainAppId, destinationAppId, algodClient, voteVerifyLsig, user, network, TIME_LOCK, goraRequestFee, algoRequestFee, requestBoxCost, VOTE_REFILL_THRESHOLD, VOTE_REFILL_AMOUNT } = testState);
    await algodClient.setBlockOffsetTimestamp(25).do();
    // testParameters = await commonTestSetup(accountGenerator);
    // MainID = testParameters.appId;
    mainAppAddress = getApplicationAddress(mainAppId);
    testAsset = testState.platformTokenAssetId;
    // Configure fresh variables for each test 
    sandboxAccount = (await bkr.sandbox.getAccounts()).pop()!;
    await sendGenericAsset(sandboxAccount.signer, testAsset, sandboxAccount.addr, sandboxAccount.addr, 0);
    await sendGenericAsset(makeBasicAccountTransactionSigner(user), testAsset, user.addr , sandboxAccount.addr, 50_000_000_000_000);
    
    delegatorInfo = await deploy_delegator(
      testAsset,
      sandboxAccount,
      mainAppId,
      mainAppAddress
    );
    delegator_app_id = delegatorInfo["delegator_app_id"];
    delegator_app_addr = delegatorInfo["delegator_app_addr"];

    await compileBeaker("assets/vesting/vesting.py",{MAIN_APP_ID: mainAppId});
    const program = JSON.parse(fs.readFileSync("./assets/vesting/artifacts/application.json", "utf-8"));
    const approvalProgram = program.source.approval;
    const clearProgram = program.source.clear;
    sandboxAppClient = getVestingClient(
      {addr: sandboxAccount.addr, sk: sandboxAccount.privateKey},
      algodClient,
      approvalProgram,
      clearProgram
    );

    appCreateResults = await sandboxAppClient._create({extraPages: 1});
    appId  = appCreateResults.appId;
    appAddress = appCreateResults.appAddress;
  });

  // Only run each test individually to generate info for testing the web app functions
  // TODO: I will need to improve how this is done, but in the mean time this will have to do
  
  it("should output test info for non vested delegators", async () => {
    const NUM_USERS = 10;
    users = [];
    for(let i = 0; i < NUM_USERS; i++)
    {
      const user = generateAccount();
      await sendGenericPayment(sandboxAccount.signer, sandboxAccount.addr, user.addr, 1e6);
      await sendGenericAsset(makeBasicAccountTransactionSigner(user), testAsset, user.addr, user.addr, 0);
      await sendGenericAsset(sandboxAccount.signer, testAsset, sandboxAccount.addr, user.addr, 20_000);
      users.push(modifyAccount(user));
    }
    
    await sendGenericPayment(sandboxAccount.signer, sandboxAccount.addr, appAddress, 100_000);
    testState.mainAccount = modifyAccount(testState.mainAccount);
    // testState.voteVerifyLsig.lsig.logic = Buffer.from(voteVerifyLsig.lsig.logic).toString("base64");
    testState.user = modifyAccount(testState.user);
    testState.alt_user = modifyAccount(testState.alt_user);
    testSetupInfo = {
      testState,
      sandboxAccount,
      delegatorInfo,
      appCreateResults,
      users
    };
    fs.writeFileSync(path.resolve(__dirname,"./test_setup_info.json"), JSON.stringify(testSetupInfo,null,2));
  });

  it.only("should output test info for vested delegators", async () => {
    const NUM_USERS = 10;
    users = [];
    for(let i = 0; i < NUM_USERS; i++)
    {   
      const user = generateAccount();
      await sendGenericPayment(sandboxAccount.signer, sandboxAccount.addr, user.addr, 1e6);
      users.push(user);
    }
    await sendGenericAsset(makeBasicAccountTransactionSigner(users[0]), testAsset, users[0].addr, users[0].addr, 0);
    await sendGenericAsset(sandboxAccount.signer, testAsset, sandboxAccount.addr, users[0].addr, 20_000);
    console.log(sandboxAppClient.appAddress);
    fundAccount(sandboxAppClient.appAddress,1e6);

    const optin_algo_transferTxn = {
      txn: makePaymentTxnWithSuggestedParamsFromObject({
        from: users[0].addr,
        suggestedParams: await algodClient.getTransactionParams().do(),
        amount: 100_000,
        to: appAddress,
      }),
      signer: makeBasicAccountTransactionSigner(users[0])
    };
    const sp = await algodClient.getTransactionParams().do();
    const optinAsset = await sandboxAppClient.compose.optin_asset(
      {
        algo_xfer: optin_algo_transferTxn,
        asset: BigInt(testAsset),
        main_app_id: BigInt(mainAppId),
        main_app_addr: getApplicationAddress(mainAppId)
      },
      {
        suggestedParams: {
          ...sp,
          flatFee: true,
          fee: 2000
        }
      }
    );
    await optinAsset.execute(algodClient,5);
    for (let i = 1; i < users.length; i++){
      
      const algo_transferTxn = {
        txn: makePaymentTxnWithSuggestedParamsFromObject({
          from: users[0].addr,
          suggestedParams: await algodClient.getTransactionParams().do(),
          amount: 57_300,
          to: appAddress,
        }),
        signer: makeBasicAccountTransactionSigner(users[0])
      };
  
      const token_transferTxn = {
        txn: makeAssetTransferTxnWithSuggestedParamsFromObject({
          from: users[0].addr,
          suggestedParams: await algodClient.getTransactionParams().do(),
          amount: 1500,
          to: appAddress,
          assetIndex: testAsset
        }),
        signer: makeBasicAccountTransactionSigner(users[0])
      };
      const asset_64 = new ABIUintType(64);
      const key = new Uint8Array(Buffer.from("goracle_vesting"));
      const key_hash = new Uint8Array(sha512_256.arrayBuffer([...asset_64.encode(testAsset), ...decodeAddress(sandboxAccount.addr).publicKey, ...key]));
      const vestingKey = VestingKey.encode([users[i].addr, key_hash]);
  
      const vestTokens = await sandboxAppClient.compose.vest_tokens(
        {
          algo_xfer: algo_transferTxn,
          token_xfer: token_transferTxn,
          vest_to: users[i].addr,
          vesting_key: key,
          time_to_vest: BigInt(10*60)
        },
        {
          boxes: [
            {
              name: vestingKey,
              appIndex: appId
            }
          ]
        }
      );
      await vestTokens.execute(algodClient,5);
    }

    //stake when app has been added to whitelist
    const whitelist_name = new ABIUintType(64).encode(delegator_app_id);
    const addWhiteListedApp = await sandboxAppClient.compose.add_whitelisted_app({
      algo_xfer: makePaymentTxnWithSuggestedParamsFromObject({
        from: sandboxAccount.addr,
        suggestedParams: await algodClient.getTransactionParams().do(),
        amount: 5700,
        to: appAddress,
      }),
      app_id: BigInt(delegator_app_id)
    },
    {
      boxes: [
        {
          name: whitelist_name,
          appIndex: appId
        }
      ]
    });
    await addWhiteListedApp.execute(algodClient,5);

    await sendGenericPayment(sandboxAccount.signer, sandboxAccount.addr, appAddress, 100_000);
    for(let i = 0; i < users.length; i++)
    {
      users[i] = modifyAccount(users[i]);
    }
    testState.mainAccount = modifyAccount(testState.mainAccount);
    testState.user = modifyAccount(testState.user);
    testState.alt_user = modifyAccount(testState.alt_user);
    testSetupInfo = {
      testState,
      sandboxAccount,
      delegatorInfo,
      appCreateResults,
      users
    };
    fs.writeFileSync(path.resolve(__dirname,"./test_setup_info.json"), JSON.stringify(testSetupInfo,null,2));
  });
});
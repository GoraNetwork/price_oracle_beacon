import * as fs from "fs";
import * as bkr from "beaker-ts";
import { 
  Account, 
  makeBasicAccountTransactionSigner, 
  makePaymentTxnWithSuggestedParamsFromObject, 
  getApplicationAddress,
  Algodv2,
  LogicSigAccount,
  ABIMethod,
  decodeAddress,
} from "algosdk";
import { fundAccount } from "algotest";
import { SandboxAccount } from "beaker-ts/src/sandbox/accounts";
import { PricePair } from "../artifacts/pricepair_client";
import {
  compileBeaker,
  sendGenericAsset,
  sendGenericPayment
} from "../../../utils/beaker_test_utils";
import {
  testVote,
  waitForRounds
} from "../../../test/util/utils";
import { getRequestInfo } from "../../../utils/gora_utils";
import {
  AccountGenerator,
  VotingTestState,
  beforeEachVotingTest,
  generateUsers,
  test_optin,voter_setup
} from "../../../test/e2e/vote/voting.helpers";
import accounts from "../../../test/test_fixtures/accounts.json";
import { sha512_256 } from "js-sha512";
import { depositAlgo, depositToken } from "../../transactions/staking_transactions";
import { createRequestParamsBox, packNumber, unpackNumber } from "../utils";

describe("Price Pair Tests", () => {
  let sandboxAccount: SandboxAccount;
  let appId: number;
  let pricePairClient: PricePair;
  let MainAddress: string;
  let testAsset: number;
  let appAddress: string;
  let users : Account[];
  let goracle_timelock: number;
  let accountGenerator: AccountGenerator;
  let algodClient: Algodv2;
  let TIME_LOCK: number;
  let votingAppId: number;
  let destinationAppId: number;
  let user: Account;
  let current_request_round: any;
  let network: number;
  let testState: VotingTestState;
  let voteVerifyLsig: LogicSigAccount;
  let mainAppId: number;
  let goraRequestFee: number;
  let algoRequestFee: number;
  let requestBoxCost: number;
  let VOTE_REFILL_THRESHOLD: number;
  let VOTE_REFILL_AMOUNT: number;
  let optInMethod: ABIMethod;

  let approvalProgram: any;
  let clearProgram: any;

  function getPricePairClient(user: Account){
    const client = new PricePair(
      {
        client: bkr.clients.sandboxAlgod(),
        signer: makeBasicAccountTransactionSigner(user),
        sender: user.addr,
        appId: appId
      }
    );
    client.approvalProgram = approvalProgram;
    client.clearProgram = clearProgram;
    return client;
  }

  beforeEach(async () => {
    goracle_timelock = 10;
    accountGenerator = new AccountGenerator(accounts);
    testState = await beforeEachVotingTest(accountGenerator);
    // flatten the testState object
    ({ current_request_round, votingAppId, mainAppId, destinationAppId, algodClient, voteVerifyLsig, user, network, TIME_LOCK, goraRequestFee, algoRequestFee, requestBoxCost, VOTE_REFILL_THRESHOLD, VOTE_REFILL_AMOUNT } = testState);

    MainAddress = getApplicationAddress(mainAppId);
    testAsset = testState.platformTokenAssetId;
    // Configure fresh variables for each test 
    
    // Grab an account
    sandboxAccount = (await bkr.sandbox.getAccounts()).pop()!;
    if (sandboxAccount === undefined) return;
    const NUM_USERS = 10;

    await compileBeaker("assets/price_pair/price_pair.py", {MAIN_APP_ID: mainAppId, DEMO_MODE: "False"});
    const program = JSON.parse(fs.readFileSync("./assets/price_pair/artifacts/application.json", "utf-8"));
    approvalProgram = program.source.approval;
    clearProgram = program.source.clear;
    // Create a new client that will talk to our app
    // Including a signer lets it worry about signing
    // the app call transactions 
    pricePairClient = getPricePairClient({addr: sandboxAccount.addr, sk: sandboxAccount.privateKey});
    const appCreateResults = await pricePairClient.createApplication();
    appId  = appCreateResults.appId;
    appAddress = appCreateResults.appAddress;
    await fundAccount(appAddress, 1e6);

    await sendGenericPayment(sandboxAccount.signer, sandboxAccount.addr, MainAddress, 1e6);


    users = [];
    for(let i = 0; i < NUM_USERS; i++)
    {   
      const tempUser = accountGenerator.generateAccount();
      await sendGenericPayment(sandboxAccount.signer, sandboxAccount.addr, tempUser.addr, 1e6);
      await sendGenericAsset(makeBasicAccountTransactionSigner(tempUser), testAsset, tempUser.addr, tempUser.addr, 0);
      await sendGenericAsset(makeBasicAccountTransactionSigner(testState.mainAccount), testAsset, testState.mainAccount.addr, tempUser.addr, 20_000);
      users.push(tempUser);
    }
    testState.ephemeral_map = await test_optin({addr: sandboxAccount.addr, sk: sandboxAccount.privateKey},mainAppId,testState,accountGenerator)
  });

  it("should allow a request param box, create price box, send request, update price, delete request param box, delete create price box", async () => {
    fundAccount(appAddress,602_500 + 200_000)
    const sp = await pricePairClient.client.getTransactionParams().do()
    const optInGoraTxn = await pricePairClient.compose.opt_in_gora(
      {
        asset_reference: BigInt(testAsset),
        main_app_reference: BigInt(mainAppId)
      },
      {
        suggestedParams: {
          ...sp,
          flatFee: true,
          fee: 3000
        }
      }
    )
    await optInGoraTxn.execute(pricePairClient.client,5)

    const voters = generateUsers(accountGenerator,4);
    
    for (const voter of voters) {
      testState.ephemeral_map = await test_optin(voter, mainAppId, testState, accountGenerator);
    }

    await waitForRounds(TIME_LOCK + 1);
    for (const voter of voters) {
      await voter_setup(voter, mainAppId, votingAppId, testState);
    }

    // initial vote, should result in no rewards
    // wait for participation key lock to expire 
    await waitForRounds(TIME_LOCK);
    fundAccount(user.addr, 0);

  
    const requestParams = await createRequestParamsBox(
      "btc/usd",
      testAsset,
      pricePairClient,
      sandboxAccount.addr,
      appAddress,
      appId,
      "foo"
    )
    let box = await pricePairClient.client.getApplicationBoxByName(appId,requestParams.requestParamsBoxName).do()

    let createPriceBoxTxn = await pricePairClient.compose.create_price_box(
      {
        price_pair_name: requestParams.pricePairName,
        algo_xfer: makePaymentTxnWithSuggestedParamsFromObject({
          from: sandboxAccount.addr,
          suggestedParams: await algodClient.getTransactionParams().do(),
          amount: ((requestParams.pricePairName.length) + 17)*400 + 2500,
          to: appAddress,
        }),
      },
      {
        boxes:[
          {
            appIndex: appId,
            name: requestParams.pricePairName
          }
        ]
      }
    )
    await createPriceBoxTxn.execute(pricePairClient.client,5)

    box = await pricePairClient.client.getApplicationBoxByName(appId,requestParams.pricePairName).do()

    const nextRequestParamsBox = await createRequestParamsBox(
      "eth/usd",
      testAsset,
      pricePairClient,
      sandboxAccount.addr,
      appAddress,
      appId,
      "bar"
    )

    createPriceBoxTxn = await pricePairClient.compose.create_price_box(
      {
        price_pair_name: nextRequestParamsBox.pricePairName,
        algo_xfer: makePaymentTxnWithSuggestedParamsFromObject({
          from: sandboxAccount.addr,
          suggestedParams: await algodClient.getTransactionParams().do(),
          amount: ((nextRequestParamsBox.pricePairName.length) + 17)*400 + 2500,
          to: appAddress,
        }),
      },
      {
        boxes:[
          {
            appIndex: appId,
            name: nextRequestParamsBox.pricePairName
          }
        ]
      }
    )
    await createPriceBoxTxn.execute(pricePairClient.client,5)

    const depositAlgoTxn =  depositAlgo({
      user: {addr: sandboxAccount.addr, sk: sandboxAccount.privateKey}, 
      appId: mainAppId, 
      suggestedParams: sp, 
      amount: 1e7,
      account_to_deposit_to: appAddress
    })
    await depositAlgoTxn.execute(pricePairClient.client,5);

    const depositGoraTxn =  depositToken({
      platformTokenAssetId: testAsset,
      user: {addr: sandboxAccount.addr, sk: sandboxAccount.privateKey}, 
      appId: mainAppId, 
      suggestedParams: sp, 
      amount: 1e10,
      account_to_deposit_to: appAddress
    })
    await depositGoraTxn.execute(pricePairClient.client,5);

    const sendRequestTxn = await pricePairClient.compose.send_request(
    // await pricePairClient.send_request(
      {
        price_pair_name: requestParams.pricePairName,
        key: requestParams.requestKey
      },
      {
        boxes:[
          {
            appIndex: appId,
            name: requestParams.requestParamsBoxName
          },
          {
            appIndex: mainAppId,
            name: new Uint8Array(sha512_256.arrayBuffer([ ...decodeAddress(appAddress).publicKey, ...requestParams.requestKey]))
          }
        ],
        appForeignApps:[
          mainAppId
        ]
      }
    )

    const request_result = await sendRequestTxn.execute(pricePairClient.client,5)
    const key_hash = request_result.methodResults[0].txInfo!.txn.txn.apbx[1].n;
    const request_info = await getRequestInfo(mainAppId, key_hash, algodClient);
    current_request_round = request_info.request_round;

    const voteNumber = 3.14
    let winningVote;
    for (let i = 0; i < voters.length; i++) {
      const voter = voters[i];
      const participationAccount = testState.ephemeral_map.get(voter.addr);
      if (!participationAccount) {
        throw new Error("Participation account does not exist for voter");
      }
      // Buffer.from("0".repeat(17))
      const vote = testVote({
        algodClient,
        voter: participationAccount,
        userVote: packNumber(voteNumber),
        mainAppId,
        votingAppId,
        destinationAppId: appId,
        requesterAddress: appAddress,
        primaryAccount: voter.addr,
        methodSelector: pricePairClient.methods[8].getSelector(),
        requestRound: current_request_round,
        voteVerifyLsig,
        timelock: TIME_LOCK,
        request_key_hash: key_hash,
        boxRefs: [
          {
            appIndex: appId,
            name: requestParams.pricePairName
          }
        ],
        userData: Buffer.from(requestParams.pricePairName).toString()
      });
      try {
        winningVote = await vote;
      } catch (e) {
        // case where voter votes on an already completed request due to randomness in number of votes assigned to each voter
        await expect(vote).rejects.toThrowError("2000076");
        break;
      }
    }

    const pricePairBoxBytes = await pricePairClient.client.getApplicationBoxByName(appId,requestParams.pricePairName).do()

    const output = unpackNumber(Buffer.from(pricePairBoxBytes.value))
    expect(voteNumber).toEqual(Number(output))

    await pricePairClient.delete_price_box(
      {
        price_pair_name:requestParams.pricePairName
      },
      {
        suggestedParams: {
           ...sp,
           flatFee: true,
           fee: 2000
        },
        boxes: [
          {
            appIndex: appId,
            name: requestParams.pricePairName
          }
        ],
      }
    )

    await pricePairClient.delete_request_params_box(
      {
        price_pair_name:requestParams.pricePairName
      },
      {
        suggestedParams: {
           ...sp,
           flatFee: true,
           fee: 2000
        },
        boxes: [
          {
            appIndex: appId,
            name: requestParams.requestParamsBoxName
          }
        ],
      },
    )

    await pricePairClient.update_manager(
      {
        new_manager: voters[0].addr
      }
    )
  });
});
import path from "path";
import * as fs from "fs";
import * as bkr from "beaker-ts";
import { 
  Account, 
  encodeUint64, 
  makeAssetTransferTxnWithSuggestedParamsFromObject, 
  makeBasicAccountTransactionSigner, 
  makePaymentTxnWithSuggestedParamsFromObject, 
  getApplicationAddress,
  Algodv2,
  LogicSigAccount,
  getMethodByName,
  ABIMethod,
  computeGroupID,
  waitForConfirmation
} from "algosdk";
import { fundAccount } from "algotest";
import { getSuggestedParams, loadABIContract } from "algoutils";


import { SandboxAccount } from "beaker-ts/src/sandbox/accounts";
import { StakeDelegator } from "../artifacts/stakedelegator_client";
import { compileBeaker, sendGenericAsset, sendGenericPayment } from "../../../utils/beaker_test_utils";
import { DestinationType, RequestArgsType } from "../../../utils/abi_types";
import { testVote, waitForRounds } from "../../../test/util/utils";
import { getGlobalStateMain, getGlobalStateVote, getLocalStateMain, getRequestInfo } from "../../../utils/gora_utils";
import { getGlobal, getLocal, getPredictedLocal, participation_optin } from "../delegatorUtils";
import { AccountGenerator, VotingTestState, beforeEachVotingTest, generateUsers, test_optin,voter_setup, submit_test_request } from "../../../test/e2e/vote/voting.helpers";
import accounts from "../../../test/test_fixtures/accounts.json";
import { update_protocol_settings } from "../../transactions/main_transactions";
import { request } from "../../../assets/transactions/request_transactions";
import { registerVoter } from "../../transactions/vote_transactions";
import { Vesting } from "../../vesting/artifacts/vesting_client";
import { globalZeroAddress } from "@algo-builder/algob";

async function sleep_rounds(rounds:number, acc:SandboxAccount){
  for(let i = 0; i < rounds; i++)
  {
    await sendGenericPayment(acc.signer, acc.addr, acc.addr, 0);
  }
}

const ABI_PATH = "../../../test/test_fixtures/consumer-contract.json";
const consumerContract = loadABIContract(path.join(__dirname, ABI_PATH));
const consumerMethod = consumerContract.methods[0].getSelector();

describe("Stake Delegator Tests", () => {
  let sandboxAccount: SandboxAccount;
  let sandboxAppClient: StakeDelegator;
  let appId: number;
  let MainAddress: string;
  let testAsset: number;
  let appAddress: string;
  let users : Account[];
  let goracle_timelock: number;
  let accountGenerator: AccountGenerator;
  let algodClient: Algodv2;
  // let testParameters: any;
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

  function getDelegatorClient(user: Account){
    const client = new StakeDelegator(
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

  beforeEach(async () => {
    goracle_timelock = 10;
    accountGenerator = new AccountGenerator(accounts);
    testState = await beforeEachVotingTest(accountGenerator);
    // flatten the testState object
    ({ current_request_round, votingAppId, mainAppId, destinationAppId, algodClient, voteVerifyLsig, user, network, TIME_LOCK, goraRequestFee, algoRequestFee, requestBoxCost, VOTE_REFILL_THRESHOLD, VOTE_REFILL_AMOUNT } = testState);

    // testParameters = await commonTestSetup(accountGenerator);
    // MainID = testParameters.appId;
    MainAddress = getApplicationAddress(mainAppId);
    testAsset = testState.platformTokenAssetId;
    // Configure fresh variables for each test 
    
    // Grab an account
    sandboxAccount = (await bkr.sandbox.getAccounts()).pop()!;
    if (sandboxAccount === undefined) return;
    const NUM_USERS = 10;

    await compileBeaker("assets/stake_delegator/stake_delegator.py", {GORA_TOKEN_ID: testAsset, MAIN_APP_ID: mainAppId});
    let program = JSON.parse(fs.readFileSync("./assets/stake_delegator/artifacts/application.json", "utf-8"));
    approvalProgram = program.source.approval;
    clearProgram = program.source.clear;
    // Create a new client that will talk to our app
    // Including a signer lets it worry about signing
    // the app call transactions 
    sandboxAppClient = getDelegatorClient({addr: sandboxAccount.addr, sk: sandboxAccount.privateKey});

    let appCreateResults = await sandboxAppClient._create({extraPages: 1});
    appId  = appCreateResults.appId;
    appAddress = appCreateResults.appAddress;

    await sendGenericPayment(sandboxAccount.signer, sandboxAccount.addr, MainAddress, 1e6);

    await compileBeaker("assets/vesting/vesting.py",{MAIN_APP_ID: mainAppId});
    program = JSON.parse(fs.readFileSync("./assets/vesting/artifacts/application.json", "utf-8"));
    approvalProgram = program.source.approval;
    clearProgram = program.source.clear;
    const vestingClient = getVestingClient(
      {addr: sandboxAccount.addr, sk: sandboxAccount.privateKey},
      algodClient,
      approvalProgram,
      clearProgram
    );

    appCreateResults = await vestingClient._create({extraPages: 1});

    users = [];
    for(let i = 0; i < NUM_USERS; i++)
    {   
      const tempUser = accountGenerator.generateAccount();
      await sendGenericPayment(sandboxAccount.signer, sandboxAccount.addr, tempUser.addr, 1e6);
      await sendGenericAsset(makeBasicAccountTransactionSigner(tempUser), testAsset, tempUser.addr, tempUser.addr, 0);
      await sendGenericAsset(makeBasicAccountTransactionSigner(testState.mainAccount), testAsset, testState.mainAccount.addr, tempUser.addr, 20_000);
      users.push(tempUser);
    }
    sandboxAppClient.methods;
    optInMethod = getMethodByName(sandboxAppClient.methods,"opt_in");
    await sandboxAppClient._optIn({
      appArgs: [
        optInMethod.getSelector(),
        encodeUint64(BigInt(0))
      ]
    });
  });
  
  async function stake(amount: number, user: Account) {
    const state = await getGlobal(appId);
    const userClient = getDelegatorClient(user);
    const sp = await userClient.client.getTransactionParams().do();
    sp.flatFee = true;
    sp.fee = 4000;
    const stake = await userClient.compose.stake({
      asset_pay: makeAssetTransferTxnWithSuggestedParamsFromObject(
        {
          from: user.addr, 
          to: appAddress,
          amount: amount,
          assetIndex: testAsset,
          suggestedParams: await userClient.client.getTransactionParams().do()
        }
      ),
      vesting_on_behalf_of: globalZeroAddress,
      main_app_ref: BigInt(mainAppId),
      asset_reference: BigInt(testAsset),
      manager_reference: sandboxAccount.addr
    },
    {
      suggestedParams: sp
    });
    const result = await stake.execute(algodClient,5);

    return result;
  }

  async function unstake(amount: number, user: Account) {
    const state = await getGlobal(appId);
    const userClient = getDelegatorClient(user);
    const sp = await userClient.client.getTransactionParams().do();
    const unstake = await userClient.compose.unstake({
      amount_to_withdraw: BigInt(amount),
      main_app_ref: BigInt(mainAppId),
      asset_reference: BigInt(testAsset),
      manager_reference: sandboxAccount.addr
    },
    {
      suggestedParams:{
        ...sp,
        flatFee: true,
        fee: 2000
      }
    });
    await unstake.execute(algodClient,5);
  }

  async function unstakeAndWithdraw(amount: number, user: Account) {
    const state = await getGlobal(appId);
    const userClient = getDelegatorClient(user);
    const sp = await userClient.client.getTransactionParams().do();
    const unstake = await userClient.compose.unstake({
      amount_to_withdraw: BigInt(amount),
      main_app_ref: BigInt(mainAppId),
      asset_reference: BigInt(testAsset),
      manager_reference: sandboxAccount.addr
    },
    {
      suggestedParams:{
        ...sp,
        flatFee: true,
        fee: 2000
      }
    });
    const withdraw = await userClient.compose.withdraw_non_stake({
      vesting_on_behalf_of: globalZeroAddress,
      goracle_token_reference: BigInt(testAsset),
      main_app_reference: BigInt(mainAppId),
      manager_reference: sandboxAccount.addr
    },
    {
      suggestedParams:{
        ...sp,
        flatFee: true,
        fee: 2000
      }
    });
    unstake.addTransaction(withdraw.buildGroup()[0]);
    const results = await unstake.execute(algodClient,5);
  }

  it("Basic stake, unstake and round iteration", async () => {
    // Why don't we need to have the manager register their public key?
    await sendGenericPayment(sandboxAccount.signer, sandboxAccount.addr, appAddress, 800_000);
    //opt in all users
    for(let i = 0; i < users.length; i++)
    {
      const userClient = getDelegatorClient(users[i]);
      await userClient._optIn({
        appArgs: [
          optInMethod.getSelector(),
          encodeUint64(BigInt(0))
        ]
      });
    }

    const suggestedParams = await getSuggestedParams();
    suggestedParams.flatFee = true;
    suggestedParams.fee = 3000;
    const initApp = await sandboxAppClient.compose.init_app({
      asset: BigInt(testAsset),
      timelock: BigInt(goracle_timelock),
      main_app_id: BigInt(mainAppId),
      manager_address: sandboxAccount.addr,
      main_app_addr: getApplicationAddress(mainAppId),
      manager_algo_share: BigInt(0),
      manager_gora_share: BigInt(0),
      algo_xfer: makePaymentTxnWithSuggestedParamsFromObject({
        from: sandboxAccount.addr,
        suggestedParams: await algodClient.getTransactionParams().do(),
        amount: 599_500,
        to: appAddress,
      }),
    },{
      suggestedParams:suggestedParams
    });
    await initApp.execute(algodClient,5);

    //stake through until next round triggers
    await sleep_rounds(1, sandboxAccount);
    for(let i = 0; i < users.length && i <= goracle_timelock - 1; i++) //-2 cause of extra actions I have to do with the real main
    {
      await stake(10_000, users[i]);
      const state = await getGlobal(appId);
      if(i === users.length - 1 || i === goracle_timelock - 1)
      {
        expect(state["pending_deposits"]).toEqual(0);
      }
      else
      {
        expect(state["pending_deposits"]).toEqual(10_000 + (i * 10_000));
      }
      expect(state["pending_withdrawals"]).toEqual(0);
    }
    let state = await getGlobal(appId);
    await sleep_rounds(1, sandboxAccount);
    expect(state["aggregation_round"]).toEqual(2);
    await stake(10_000, users[0]);
    await stake(10_000, users[1]);
    
    state = await getGlobal(appId);
    expect(state["pending_deposits"]).toEqual(20_000);
    for(let i = 2; i < users.length && i <= goracle_timelock; i++)
    {
      await unstake(5_000, users[i]);
      const state = await getGlobal(appId);
      if(i === users.length - 1 || i === goracle_timelock)
      {
        expect(state["pending_withdrawals"]).toEqual(0);
      }
      else
      {
        expect(state["pending_withdrawals"]).toEqual(5_000 + (i * 5_000) - 10_000);
      }
    }
    state = await getGlobal(appId);
    expect(state["pending_withdrawals"]).toEqual(0);
    expect(state["pending_deposits"]).toEqual(0);
  });

  it("should accept min balance payment", async () => {
    //opt in all users
    for(let i = 0; i < users.length; i++)
    {
      const userClient = getDelegatorClient(users[i]);
      await userClient._optIn({
        appArgs: [
          optInMethod.getSelector(),
          encodeUint64(BigInt(0))
        ]
      });
    }

    const suggestedParams = await getSuggestedParams();
    suggestedParams.flatFee = true;
    suggestedParams.fee = 3000;
    const initApp = await sandboxAppClient.compose.init_app({
      asset: BigInt(testAsset),
      timelock: BigInt(goracle_timelock),
      main_app_id: BigInt(mainAppId),
      manager_address: sandboxAccount.addr,
      main_app_addr: getApplicationAddress(mainAppId),
      manager_algo_share: BigInt(0),
      manager_gora_share: BigInt(0),
      algo_xfer: makePaymentTxnWithSuggestedParamsFromObject({
        from: sandboxAccount.addr,
        suggestedParams: await algodClient.getTransactionParams().do(),
        amount: 599_500,
        to: appAddress,
      }),
    },{
      suggestedParams:suggestedParams
    });
    const paymentTxn = {
      txn: makePaymentTxnWithSuggestedParamsFromObject({
        from: sandboxAccount.addr,
        suggestedParams: await algodClient.getTransactionParams().do(),
        // ATTENTION FUTURE DELEGATOR MANAGERS:
        // 5_000_000 amount is to cover aggregation round fees and the 100_000 is for the min bal requirement to init the app.
        amount: 5_100_000,
        to: appAddress,
      }),
      signer: makeBasicAccountTransactionSigner({addr: sandboxAccount.addr,sk: sandboxAccount.privateKey}),
    };

    // This is to allow us to insert the payment txn before the app call
    const group = initApp.buildGroup();
    group.unshift(paymentTxn);

    const rawTxns = group.map((txn) => {
      txn.txn.group = undefined;
      return txn.txn;
    });
    const groupID = computeGroupID(rawTxns);

    rawTxns.forEach((txn) => {
      txn.group = groupID;
    });
    
    const signedTxns = rawTxns.map((txn) => {return txn.signTxn(sandboxAccount.privateKey);});
    const txnResult = await algodClient.sendRawTransaction(signedTxns).do();
    await waitForConfirmation(algodClient,txnResult.txId,5);

    //stake through until next round triggers
    await sleep_rounds(1, sandboxAccount);
    for(let i = 0; i < users.length && i <= goracle_timelock - 1; i++) //-2 cause of extra actions I have to do with the real main
    {
      await stake(10_000, users[i]);
      const state = await getGlobal(appId);
      if(i === users.length - 1 || i === goracle_timelock - 1)
      {
        expect(state["pending_deposits"]).toEqual(0);
      }
      else
      {
        expect(state["pending_deposits"]).toEqual(10_000 + (i * 10_000));
      }
      expect(state["pending_withdrawals"]).toEqual(0);
    }
    let state = await getGlobal(appId);
    await sleep_rounds(1, sandboxAccount);
    expect(state["aggregation_round"]).toEqual(2);
    await stake(10_000, users[0]);
    await stake(10_000, users[1]);
    
    state = await getGlobal(appId);
    expect(state["pending_deposits"]).toEqual(20_000);
    for(let i = 2; i < users.length && i <= goracle_timelock; i++)
    {
      await unstake(5_000, users[i]);
      const state = await getGlobal(appId);
      if(i === users.length - 1 || i === goracle_timelock)
      {
        expect(state["pending_withdrawals"]).toEqual(0);
      }
      else
      {
        expect(state["pending_withdrawals"]).toEqual(5_000 + (i * 5_000) - 10_000);
      }
    }
    state = await getGlobal(appId);
    expect(state["pending_withdrawals"]).toEqual(0);
    expect(state["pending_deposits"]).toEqual(0);
  });

  it("should accumulate rewards add to non stake, and then allow users to claim", async () => {
    const expectedRewards = 0;
    await sendGenericPayment(sandboxAccount.signer, sandboxAccount.addr, appAddress, 800_000);
    //opt in all users
    for(let i = 0; i < users.length; i++)
    {
      const userClient = getDelegatorClient(users[i]);
      await userClient._optIn({
        appArgs: [
          optInMethod.getSelector(),
          encodeUint64(BigInt(0))
        ]
      });
    }
    let users_staked = 0;
    let suggestedParams = await getSuggestedParams();
    suggestedParams.flatFee = true;
    suggestedParams.fee = 3000;
    const initApp = await sandboxAppClient.compose.init_app({
      asset: BigInt(testAsset),
      timelock: BigInt(goracle_timelock),
      main_app_id: BigInt(mainAppId),
      main_app_addr: getApplicationAddress(mainAppId),
      manager_address: sandboxAccount.addr,
      manager_algo_share: BigInt(0),
      manager_gora_share: BigInt(0),
      algo_xfer: makePaymentTxnWithSuggestedParamsFromObject({
        from: sandboxAccount.addr,
        suggestedParams: await algodClient.getTransactionParams().do(),
        amount: 599_500,
        to: appAddress,
      }),
    },{
      suggestedParams:suggestedParams,
    });
    await initApp.execute(algodClient,5);

    const configureSettings = await sandboxAppClient.compose.configure_settings({
      manager_address: sandboxAccount.addr,manager_algo_share: BigInt(200),
      manager_gora_share: BigInt(100)
    });
    await configureSettings.execute(algodClient,5);
    suggestedParams = await getSuggestedParams();
    suggestedParams.flatFee = true;
    suggestedParams.fee = 2000;
    const register_participation_key = await sandboxAppClient.compose.register_participation_key(
      {
        new_key: users[0].addr,
        main_ref: BigInt(mainAppId)
      },
      {
        suggestedParams
      }
    );
    expect(await register_participation_key.execute(algodClient,5));
    let aggregationTriggered = false;
    //stake through until next round triggers (time for 8 users to stake on devnet)
    for(let i = 0; i <= 9; i++)
    {
      await stake(10_000, users[i]);
      const dGlobal = await getGlobal(appId);
      
      if(dGlobal.aggregation_round == 2)
      {
        aggregationTriggered = true;
        users_staked = i;
        const voters = generateUsers(accountGenerator,4);
        const requester = accountGenerator.generateAccount();

        const state = await getGlobalStateMain(mainAppId, algodClient);
      
        const VOTE_REFILL_THRESHOLD = 550;
        const VOTE_REFILL_AMOUNT = 4;
        const upsGroup = update_protocol_settings(
          {
            user: user, 
            appId: mainAppId, 
            suggestedParams: await algodClient.getTransactionParams().do(),
            manager: state.manager_address,
            refund_request_made_percentage: state.refund_processing_percentage,
            refund_processing_percentage: state.refund_processing_percentage,
            algo_request_fee: state.algo_request_fee,
            gora_request_fee: state.gora_request_fee,
            voting_threshold: state.voting_threshold,
            time_lock: state.time_lock,
            vote_refill_threshold: VOTE_REFILL_THRESHOLD, // just updating vote_refill so that we can test it easier
            vote_refill_amount: VOTE_REFILL_AMOUNT
          }
        );
        await upsGroup.execute(algodClient, 5);

        for (const voter of voters) {
          testState.ephemeral_map = await test_optin(voter, mainAppId, testState, accountGenerator);
        }

        testState.ephemeral_map = await participation_optin(appAddress,testState,users[0]);

        testState.ephemeral_map = await test_optin(requester, mainAppId, testState, accountGenerator);
        await waitForRounds(TIME_LOCK + 1);
        for (const voter of voters) {
          await voter_setup(voter, mainAppId, votingAppId, testState);
        }

        const delegatorParticipationAccount = testState.ephemeral_map.get(appAddress)!;

        const registerVoterGroup = registerVoter({
          user: delegatorParticipationAccount,
          primaryAccount: appAddress,
          votingAppId: votingAppId,
          mainAppId: mainAppId,
          suggestedParams: await testState.algodClient.getTransactionParams().do()
        });
        await registerVoterGroup.execute(testState.algodClient, 5);

        await voter_setup(requester, mainAppId, votingAppId, testState);

        //initial vote, should result in no rewards
        //wait for participation key lock to expire 
        await waitForRounds(TIME_LOCK);
        fundAccount(user.addr, 0);
        let result;
        ({ result, current_request_round, request_map: testState.request_map, suggestedParams: testState.suggestedParams } = await submit_test_request(requester, undefined, testState));
        let request_result = result;
        let key_hash = request_result.methodResults[0].txInfo!.txn.txn.apbx[0].n;
        const old_key_hash = Buffer.from(key_hash).toString("base64");

        await testVote({
          algodClient,
          voter: delegatorParticipationAccount,
          userVote: encodeUint64(100_000),
          mainAppId,
          votingAppId,
          destinationAppId,
          requesterAddress: requester.addr,
          primaryAccount: appAddress,
          methodSelector: consumerMethod,
          requestRound: current_request_round,
          voteVerifyLsig,
          timelock: TIME_LOCK,
          request_key_hash: key_hash
        });

        for (let i = 0; i < voters.length; i++) {
          const voter = voters[i];
          const participationAccount = testState.ephemeral_map.get(voter.addr);
          if (!participationAccount) {
            throw new Error("Participation account does not exist for voter");
          }
          const vote = testVote({
            algodClient,
            voter: participationAccount,
            userVote: encodeUint64(100_000),
            mainAppId,
            votingAppId,
            destinationAppId,
            requesterAddress: requester.addr,
            primaryAccount: voter.addr,
            methodSelector: consumerMethod,
            requestRound: current_request_round,
            voteVerifyLsig,
            timelock: TIME_LOCK,
            request_key_hash: key_hash
          });
          try {
            await vote;
          } catch (e) {
            // case where voter votes on an already completed request due to randomness in number of votes assigned to each voter
            await expect(vote).rejects.toThrowError("1000004");
            break;
          }      
        }

        const app_id = 1234;
        const dest_method = consumerContract.methods[0].getSelector();
        const url_buf: Uint8Array = new Uint8Array(Buffer.from("https://api.coingecko.com/api/v3/coins/markets?vs_currency=usd&order=market_cap_desc&per_page=1&page=1"));
        const path_buf: Uint8Array = new Uint8Array(Buffer.from("market_cap"));
        const userdata = new Uint8Array(Buffer.from("Hello world"));
        const source_id = 0;
        const requestArgs = RequestArgsType.encode([[[source_id, [url_buf, path_buf], 60]], 0, userdata]);

        const request_group = request({
          user: voters[1],
          appID: mainAppId,
          suggestedParams: testState.suggestedParams,
          request_args: requestArgs,
          destination: DestinationType.encode([app_id, dest_method]),
          type: 0,
          key: Buffer.from("foo"),
          appRefs: [],
          assetRefs: [],
          accountRefs: [],
          boxRefs: []
        });
        request_result = await request_group.execute(algodClient, 5);
        key_hash = request_result.methodResults[0].txInfo!.txn.txn.apbx[0].n;
        const request_info = await getRequestInfo(mainAppId, key_hash, algodClient);
        current_request_round = request_info.request_round;

        const globalStateVote = await getGlobalStateVote(votingAppId, algodClient);
        const appAddressVoteCount = globalStateVote.previous_vote[appAddress].proposal.vote_count;

        // user manually claiming own rewards
        let localStateMain = await getLocalStateMain(appAddress, mainAppId, algodClient);
        const preClaimVoterAlgo = localStateMain.account_algo;
        const preClaimVoterToken = localStateMain.account_token_amount;
        const globalStateMain = await getGlobalStateMain(mainAppId, algodClient);
        const expectedVoteCount: number = globalStateMain.requests_completed[old_key_hash].vote_count;
        await testVote({
          algodClient,
          voter: delegatorParticipationAccount,
          userVote: encodeUint64(1),
          mainAppId,
          votingAppId,
          destinationAppId,
          requesterAddress: voters[1].addr,
          primaryAccount: appAddress,
          requestRound: current_request_round,
          methodSelector: consumerMethod,
          voteVerifyLsig,
          timelock: TIME_LOCK,
          request_key_hash: key_hash
        });
        localStateMain = await getLocalStateMain(appAddress, mainAppId, algodClient);
        const postClaimVoterAlgo = localStateMain.account_algo;
        const postClaimVoterToken = localStateMain.account_token_amount;
        const algoRewardResults: number = postClaimVoterAlgo - preClaimVoterAlgo;
        const tokenRewardResults: number = postClaimVoterToken - preClaimVoterToken;

        const pendingRewardsPoints = Math.floor((appAddressVoteCount * 1_000_000 / expectedVoteCount));
        const expectedRewardsAlgo = pendingRewardsPoints * Math.floor(algoRequestFee / 1_000_000);
        const expectedRewardsGora = pendingRewardsPoints * Math.floor(goraRequestFee / 1_000_000);
        expect(expectedRewardsAlgo).toEqual(algoRewardResults);
        expect(expectedRewardsGora).toEqual(tokenRewardResults);
        break;
      }
    }
    expect(aggregationTriggered).toEqual(true);

    await waitForRounds(TIME_LOCK * 3);
    const userStakeAmount = 0;
    await stake(userStakeAmount, users[9]);
    let delegatorGlobal = await getGlobal(appId);
    const availableAlgoRewards =delegatorGlobal.previous_aggregation.algo_rewards; 

    const availableGoraRewards = delegatorGlobal.previous_aggregation.gora_rewards;

    await stake(userStakeAmount, users[0]);
    const postStakeLocal = await getLocal(appId,users[0].addr,algodClient);
    const userAlgoReward = postStakeLocal.local_non_stake.algo_rewards;
    const userGoraReward = postStakeLocal.local_non_stake.gora_rewards;

    delegatorGlobal = await getGlobal(appId);

    expect(
      Math.floor(availableAlgoRewards / postStakeLocal.last_update_time)
    ).toEqual(userAlgoReward);
    expect(
      Math.floor(availableGoraRewards / users_staked)
    ).toEqual(userGoraReward);
    const stake_time_claimed = 10_000; //this represents that 1 user has claimed 10_000 of the staketime (this will help when checking values further in the tests)

    const predictedLocal2 = await getPredictedLocal(appId, mainAppId, users[9].addr); // this user didn't get a chance to stake before the round was over

    //everyone has the same staketime since the "time" element is aggregation rounds and everyone staked during the first aggregation round
    expect(Math.floor(predictedLocal2.predicted_rewards_algo)).toEqual(0);
    expect(Math.floor(predictedLocal2.predicted_rewards_gora)).toEqual(0);

    //claim rewards
    const userClient = getDelegatorClient(users[1]);
    let asset_info_result = await userClient.client.accountAssetInformation(users[1].addr, testAsset).do();
    let assetBalance_pre = asset_info_result["asset-holding"]["amount"];
    let account_info_result = await userClient.client.accountInformation(users[1].addr).do();
    const algo_balance_pre = account_info_result["amount"];

    const sp = await userClient.client.getTransactionParams().do();
    sp.flatFee = true;
    sp.fee = 4000;
    const userClaim = await userClient.compose.user_claim(
      {
        asset_reference: BigInt(testAsset),
        main_app_reference: BigInt(mainAppId),
        manager_reference: sandboxAccount.addr
      },
      {
        suggestedParams: sp
      }
    );
    await userClaim.execute(userClient.client,5);
    
    asset_info_result = await userClient.client.accountAssetInformation(users[1].addr, testAsset).do();
    let assetBalance_post = asset_info_result["asset-holding"]["amount"];
    account_info_result = await userClient.client.accountInformation(users[1].addr).do();
    const algo_balance_post = account_info_result["amount"];
    delegatorGlobal = await getGlobal(appId);
    expect(Math.round(4000 + algo_balance_post - algo_balance_pre)).toEqual(userAlgoReward); //4k because 4 txns (one is an opup)
    expect(assetBalance_post - assetBalance_pre).toEqual(
      Math.floor(
        (10_000 * delegatorGlobal.previous_aggregation.gora_rewards)
        / delegatorGlobal.global_stake_time
      )
    ); // have to adjust for above claim

    await sleep_rounds(goracle_timelock, sandboxAccount);
    await getPredictedLocal(appId, mainAppId, users[1].addr);

    //unstake 
    await unstake(10_000, users[1]);

    await getPredictedLocal(appId, mainAppId, users[1].addr);
    await sleep_rounds(goracle_timelock, sandboxAccount);

    asset_info_result = await userClient.client.accountAssetInformation(users[1].addr, testAsset).do();
    assetBalance_pre = asset_info_result["asset-holding"]["amount"];
  
    await userClient.withdraw_non_stake({
      vesting_on_behalf_of: globalZeroAddress,
      goracle_token_reference: BigInt(testAsset),
      main_app_reference: BigInt(mainAppId),
      manager_reference: sandboxAccount.addr
    },
    {
      suggestedParams: sp
    });
    asset_info_result = await userClient.client.accountAssetInformation(users[1].addr, testAsset).do();
    assetBalance_post = asset_info_result["asset-holding"]["amount"];
    expect(assetBalance_post - assetBalance_pre).toEqual(10_000);
  });

  it("should accumulate rewards add to non stake, and then allow users to unstake and claim at once", async () => {
    const expectedRewards = 0;
    await sendGenericPayment(sandboxAccount.signer, sandboxAccount.addr, appAddress, 800_000);
    //opt in all users
    for(let i = 0; i < users.length; i++)
    {
      const userClient = getDelegatorClient(users[i]);
      await userClient._optIn({
        appArgs: [
          optInMethod.getSelector(),
          encodeUint64(BigInt(0))
        ]
      });
    }
    let users_staked = 0;
    let suggestedParams = await getSuggestedParams();
    suggestedParams.flatFee = true;
    suggestedParams.fee = 3000;
    const initApp = await sandboxAppClient.compose.init_app({
      asset: BigInt(testAsset),
      timelock: BigInt(goracle_timelock),
      main_app_id: BigInt(mainAppId),
      main_app_addr: getApplicationAddress(mainAppId),
      manager_address: sandboxAccount.addr,
      manager_algo_share: BigInt(0),
      manager_gora_share: BigInt(0),
      algo_xfer: makePaymentTxnWithSuggestedParamsFromObject({
        from: sandboxAccount.addr,
        suggestedParams: await algodClient.getTransactionParams().do(),
        amount: 599_500,
        to: appAddress,
      }),
    },{
      suggestedParams:suggestedParams,
    });
    await initApp.execute(algodClient,5);

    const configureSettings = await sandboxAppClient.compose.configure_settings({
      manager_address: sandboxAccount.addr,manager_algo_share: BigInt(200),
      manager_gora_share: BigInt(100)
    });
    await configureSettings.execute(algodClient,5);
    suggestedParams = await getSuggestedParams();
    suggestedParams.flatFee = true;
    suggestedParams.fee = 2000;
    const register_participation_key = await sandboxAppClient.compose.register_participation_key(
      {
        new_key: users[0].addr,
        main_ref: BigInt(mainAppId)
      },
      {
        suggestedParams
      }
    );
    expect(await register_participation_key.execute(algodClient,5));
    let aggregationTriggered = false;
    //stake through until next round triggers (time for 8 users to stake on devnet)
    for(let i = 0; i <= 9; i++)
    {
      await stake(10_000, users[i]);
      const dGlobal = await getGlobal(appId);
      
      if(dGlobal.aggregation_round == 2)
      {
        aggregationTriggered = true;
        users_staked = i;
        const voters = generateUsers(accountGenerator,4);
        const requester = accountGenerator.generateAccount();

        const state = await getGlobalStateMain(mainAppId, algodClient);
      
        const VOTE_REFILL_THRESHOLD = 550;
        const VOTE_REFILL_AMOUNT = 4;
        const upsGroup = update_protocol_settings(
          {
            user: user, 
            appId: mainAppId, 
            suggestedParams: await algodClient.getTransactionParams().do(),
            manager: state.manager_address,
            refund_request_made_percentage: state.refund_processing_percentage,
            refund_processing_percentage: state.refund_processing_percentage,
            algo_request_fee: state.algo_request_fee,
            gora_request_fee: state.gora_request_fee,
            voting_threshold: state.voting_threshold,
            time_lock: state.time_lock,
            vote_refill_threshold: VOTE_REFILL_THRESHOLD, // just updating vote_refill so that we can test it easier
            vote_refill_amount: VOTE_REFILL_AMOUNT
          }
        );
        await upsGroup.execute(algodClient, 5);

        for (const voter of voters) {
          testState.ephemeral_map = await test_optin(voter, mainAppId, testState, accountGenerator);
        }

        testState.ephemeral_map = await participation_optin(appAddress,testState,users[0]);

        testState.ephemeral_map = await test_optin(requester, mainAppId, testState, accountGenerator);
        await waitForRounds(TIME_LOCK + 1);
        for (const voter of voters) {
          await voter_setup(voter, mainAppId, votingAppId, testState);
        }

        const delegatorParticipationAccount = testState.ephemeral_map.get(appAddress)!;

        const registerVoterGroup = registerVoter({
          user: delegatorParticipationAccount,
          primaryAccount: appAddress,
          votingAppId: votingAppId,
          mainAppId: mainAppId,
          suggestedParams: await testState.algodClient.getTransactionParams().do()
        });
        await registerVoterGroup.execute(testState.algodClient, 5);

        await voter_setup(requester, mainAppId, votingAppId, testState);

        //initial vote, should result in no rewards
        //wait for participation key lock to expire 
        await waitForRounds(TIME_LOCK);
        fundAccount(user.addr, 0);
        let result;
        ({ result, current_request_round, request_map: testState.request_map, suggestedParams: testState.suggestedParams } = await submit_test_request(requester, undefined, testState));
        let request_result = result;
        let key_hash = request_result.methodResults[0].txInfo!.txn.txn.apbx[0].n;
        const old_key_hash = Buffer.from(key_hash).toString("base64");

        await testVote({
          algodClient,
          voter: delegatorParticipationAccount,
          userVote: encodeUint64(100_000),
          mainAppId,
          votingAppId,
          destinationAppId,
          requesterAddress: requester.addr,
          primaryAccount: appAddress,
          methodSelector: consumerMethod,
          requestRound: current_request_round,
          voteVerifyLsig,
          timelock: TIME_LOCK,
          request_key_hash: key_hash
        });

        for (let i = 0; i < voters.length; i++) {
          const voter = voters[i];
          const participationAccount = testState.ephemeral_map.get(voter.addr);
          if (!participationAccount) {
            throw new Error("Participation account does not exist for voter");
          }
          const vote = testVote({
            algodClient,
            voter: participationAccount,
            userVote: encodeUint64(100_000),
            mainAppId,
            votingAppId,
            destinationAppId,
            requesterAddress: requester.addr,
            primaryAccount: voter.addr,
            methodSelector: consumerMethod,
            requestRound: current_request_round,
            voteVerifyLsig,
            timelock: TIME_LOCK,
            request_key_hash: key_hash
          });
          try {
            await vote;
          } catch (e) {
            // case where voter votes on an already completed request due to randomness in number of votes assigned to each voter
            await expect(vote).rejects.toThrowError("1000004");
            break;
          }      
        }

        const app_id = 1234;
        const dest_method = consumerContract.methods[0].getSelector();
        const url_buf: Uint8Array = new Uint8Array(Buffer.from("https://api.coingecko.com/api/v3/coins/markets?vs_currency=usd&order=market_cap_desc&per_page=1&page=1"));
        const path_buf: Uint8Array = new Uint8Array(Buffer.from("market_cap"));
        const userdata = new Uint8Array(Buffer.from("Hello world"));
        const source_id = 0;
        const requestArgs = RequestArgsType.encode([[[source_id, [url_buf, path_buf], 60]], 0, userdata]);

        const request_group = request({
          user: voters[1],
          appID: mainAppId,
          suggestedParams: testState.suggestedParams,
          request_args: requestArgs,
          destination: DestinationType.encode([app_id, dest_method]),
          type: 0,
          key: Buffer.from("foo"),
          appRefs: [],
          assetRefs: [],
          accountRefs: [],
          boxRefs: []
        });
        request_result = await request_group.execute(algodClient, 5);
        key_hash = request_result.methodResults[0].txInfo!.txn.txn.apbx[0].n;
        const request_info = await getRequestInfo(mainAppId, key_hash, algodClient);
        current_request_round = request_info.request_round;

        const globalStateVote = await getGlobalStateVote(votingAppId, algodClient);
        const appAddressVoteCount = globalStateVote.previous_vote[appAddress].proposal.vote_count;

        // user manually claiming own rewards
        let localStateMain = await getLocalStateMain(appAddress, mainAppId, algodClient);
        const preClaimVoterAlgo = localStateMain.account_algo;
        const preClaimVoterToken = localStateMain.account_token_amount;
        const globalStateMain = await getGlobalStateMain(mainAppId, algodClient);
        const expectedVoteCount: number = globalStateMain.requests_completed[old_key_hash].vote_count;
        await testVote({
          algodClient,
          voter: delegatorParticipationAccount,
          userVote: encodeUint64(1),
          mainAppId,
          votingAppId,
          destinationAppId,
          requesterAddress: voters[1].addr,
          primaryAccount: appAddress,
          requestRound: current_request_round,
          methodSelector: consumerMethod,
          voteVerifyLsig,
          timelock: TIME_LOCK,
          request_key_hash: key_hash
        });
        localStateMain = await getLocalStateMain(appAddress, mainAppId, algodClient);
        const postClaimVoterAlgo = localStateMain.account_algo;
        const postClaimVoterToken = localStateMain.account_token_amount;
        const algoRewardResults: number = postClaimVoterAlgo - preClaimVoterAlgo;
        const tokenRewardResults: number = postClaimVoterToken - preClaimVoterToken;

        const pendingRewardsPoints = Math.floor((appAddressVoteCount * 1_000_000 / expectedVoteCount));
        const expectedRewardsAlgo = pendingRewardsPoints * Math.floor(algoRequestFee / 1_000_000);
        const expectedRewardsGora = pendingRewardsPoints * Math.floor(goraRequestFee / 1_000_000);
        expect(expectedRewardsAlgo).toEqual(algoRewardResults);
        expect(expectedRewardsGora).toEqual(tokenRewardResults);
        break;
      }
    }
    expect(aggregationTriggered).toEqual(true);

    await waitForRounds(TIME_LOCK * 3);
    const userStakeAmount = 0;
    await stake(userStakeAmount, users[9]);
    let delegatorGlobal = await getGlobal(appId);
    const availableAlgoRewards =delegatorGlobal.previous_aggregation.algo_rewards; 

    const availableGoraRewards = delegatorGlobal.previous_aggregation.gora_rewards;

    await stake(userStakeAmount, users[0]);
    const postStakeLocal = await getLocal(appId,users[0].addr,algodClient);
    const userAlgoReward = postStakeLocal.local_non_stake.algo_rewards;
    const userGoraReward = postStakeLocal.local_non_stake.gora_rewards;

    delegatorGlobal = await getGlobal(appId);

    expect(
      Math.floor(availableAlgoRewards / postStakeLocal.last_update_time)
    ).toEqual(userAlgoReward);
    expect(
      Math.floor(availableGoraRewards / users_staked)
    ).toEqual(userGoraReward);
    const stake_time_claimed = 10_000; //this represents that 1 user has claimed 10_000 of the staketime (this will help when checking values further in the tests)

    const predictedLocal2 = await getPredictedLocal(appId, mainAppId, users[9].addr); // this user didn't get a chance to stake before the round was over

    //everyone has the same staketime since the "time" element is aggregation rounds and everyone staked during the first aggregation round
    expect(Math.floor(predictedLocal2.predicted_rewards_algo)).toEqual(0);
    expect(Math.floor(predictedLocal2.predicted_rewards_gora)).toEqual(0);

    //claim rewards
    const userClient = getDelegatorClient(users[1]);
    let asset_info_result = await userClient.client.accountAssetInformation(users[1].addr, testAsset).do();
    let assetBalance_pre = asset_info_result["asset-holding"]["amount"];
    let account_info_result = await userClient.client.accountInformation(users[1].addr).do();
    const algo_balance_pre = account_info_result["amount"];

    const sp = await userClient.client.getTransactionParams().do();
    sp.flatFee = true;
    sp.fee = 4000;
    const userClaim = await userClient.compose.user_claim(
      {
        asset_reference: BigInt(testAsset),
        main_app_reference: BigInt(mainAppId),
        manager_reference: sandboxAccount.addr
      },
      {
        suggestedParams: sp
      }
    );
    await userClaim.execute(userClient.client,5);
    
    asset_info_result = await userClient.client.accountAssetInformation(users[1].addr, testAsset).do();
    let assetBalance_post = asset_info_result["asset-holding"]["amount"];
    account_info_result = await userClient.client.accountInformation(users[1].addr).do();
    const algo_balance_post = account_info_result["amount"];
    delegatorGlobal = await getGlobal(appId);
    expect(Math.round(4000 + algo_balance_post - algo_balance_pre)).toEqual(userAlgoReward); //4k because 4 txns (one is an opup)
    expect(assetBalance_post - assetBalance_pre).toEqual(
      Math.floor(
        (10_000 * delegatorGlobal.previous_aggregation.gora_rewards)
        / delegatorGlobal.global_stake_time
      )
    ); // have to adjust for above claim

    await sleep_rounds(goracle_timelock, sandboxAccount);
    await getPredictedLocal(appId, mainAppId, users[1].addr);

    asset_info_result = await userClient.client.accountAssetInformation(users[1].addr, testAsset).do();
    assetBalance_pre = asset_info_result["asset-holding"]["amount"];

    //unstake 
    await unstakeAndWithdraw(10_000, users[1]);

    await getPredictedLocal(appId, mainAppId, users[1].addr);
    await sleep_rounds(goracle_timelock, sandboxAccount);

    asset_info_result = await userClient.client.accountAssetInformation(users[1].addr, testAsset).do();
    assetBalance_post = asset_info_result["asset-holding"]["amount"];
    expect(assetBalance_post - assetBalance_pre).toEqual(10_000);
    await fundAccount(users[1].addr,0);

    asset_info_result = await userClient.client.accountAssetInformation(users[1].addr, testAsset).do();
    assetBalance_pre = asset_info_result["asset-holding"]["amount"];

    const userClaim2 = await userClient.compose.user_claim(
      {
        asset_reference: BigInt(testAsset),
        main_app_reference: BigInt(mainAppId),
        manager_reference: sandboxAccount.addr
      },
      {
        suggestedParams: {
          ...sp,
          flatFee: true,
          fee: 4000
        },
        note: new Uint8Array(Buffer.from("test"))
      }
    );
    await expect(userClaim2.execute(userClient.client,5)).rejects.toThrow("assert failed");
    asset_info_result = await userClient.client.accountAssetInformation(users[1].addr, testAsset).do();
    assetBalance_post = asset_info_result["asset-holding"]["amount"];
    expect(assetBalance_post-assetBalance_pre).toBe(0);
  });

  it("manager key registration", async () => {
    await sendGenericPayment(sandboxAccount.signer, sandboxAccount.addr, appAddress, 800_000);
    //opt in all users
    for(let i = 0; i < users.length; i++)
    {
      const userClient = getDelegatorClient(users[i]);
      await userClient._optIn({
        appArgs: [
          optInMethod.getSelector(),
          encodeUint64(BigInt(0))
        ]
      });
    }
    let suggestedParams = await getSuggestedParams();
    suggestedParams.flatFee = true;
    suggestedParams.fee = 3000;
    const initApp = await sandboxAppClient.compose.init_app({
      asset: BigInt(testAsset),
      timelock: BigInt(goracle_timelock),
      main_app_id: BigInt(mainAppId),
      main_app_addr: getApplicationAddress(mainAppId),
      manager_address: sandboxAccount.addr,
      manager_algo_share: BigInt(0),
      manager_gora_share: BigInt(0),
      algo_xfer: makePaymentTxnWithSuggestedParamsFromObject({
        from: sandboxAccount.addr,
        suggestedParams: await algodClient.getTransactionParams().do(),
        amount: 599_500,
        to: appAddress,
      }),
    },{
      suggestedParams:suggestedParams
    });
    await initApp.execute(algodClient,5);

    //should not allow non manager to change participation key
    const userClient = getDelegatorClient(users[0]);
  
    await expect(userClient.register_participation_key({new_key: users[0].addr, main_ref: BigInt(mainAppId)})).rejects.toThrow("assert failed");
    
    //should allow manager to register
    suggestedParams = await getSuggestedParams();
    suggestedParams.flatFee = true;
    suggestedParams.fee = 2000;
    const registerParticipationKey = await sandboxAppClient.compose.register_participation_key(
      {
        new_key: users[0].addr,
        main_ref: BigInt(mainAppId)
      },
      {
        suggestedParams: suggestedParams
      }
    );
    expect(await registerParticipationKey.execute(algodClient,5));

    const local_state = await getLocalStateMain(appAddress, mainAppId, sandboxAppClient.client);
    expect(local_state.local_public_key).toEqual(users[0].addr);
  });
});
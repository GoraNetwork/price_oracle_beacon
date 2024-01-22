import { 
  Account, 
  generateAccount, 
  getApplicationAddress, 
  makeAssetCreateTxnWithSuggestedParamsFromObject, 
  makeAssetTransferTxnWithSuggestedParamsFromObject, 
  makeBasicAccountTransactionSigner, 
  makePaymentTxnWithSuggestedParamsFromObject,
  getMethodByName,
  ABIMethod,
  encodeUint64,
  Algodv2
} from "algosdk";
import * as bkr from "beaker-ts";

import { SandboxAccount } from "beaker-ts/src/sandbox/accounts";
import { StakeDelegator } from "../artifacts/stakedelegator_client";
import { MockMain } from "../artifacts/mock_main/mockmain_client";
import { compileBeaker, sendGenericAsset, sendGenericPayment } from "../../../utils/beaker_test_utils";
import { getGlobal, getMockMainLocal, getPredictedLocal } from "../delegatorUtils";
import * as fs from "fs";
import { getSuggestedParams } from "algoutils";
import { Vesting } from "../../vesting/artifacts/vesting_client";
import { globalZeroAddress } from "@algo-builder/algob";

async function sleep_rounds(rounds:number, acc:SandboxAccount){
  for(let i = 0; i < rounds; i++)
  {
    await sendGenericPayment(acc.signer, acc.addr, acc.addr, 0);
  }
}

describe("Stake Delegator Tests", () => {
  let sandboxAccount: SandboxAccount;
  let sandboxAppClient: StakeDelegator;
  let sandboxMockMainClient: MockMain;
  let appId: number;
  let mockMainID: number;
  let mockMainAddress: string;
  let testAsset: number;
  let appAddress: string;
  let users : Account[];
  let goracle_timelock: number;
  let optInMethod: ABIMethod;

  let approvalProgram: any;
  let clearProgram: any;
  
  function sleep(ms: number) {
    return new Promise( resolve => setTimeout(resolve, ms) );
  }

  function getDelegatorClient(user: Account){
    const client = new StakeDelegator(
      {
        client: bkr.clients.sandboxAlgod(),
        signer: makeBasicAccountTransactionSigner(user),
        sender: user.addr,
        appId: appId
      });
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
    // Grab an account
    sandboxAccount = (await bkr.sandbox.getAccounts()).pop()!;
    if (sandboxAccount === undefined) return;
    const NUM_USERS = 11;
    const tCreation = makeAssetCreateTxnWithSuggestedParamsFromObject(
      {
        from: sandboxAccount.addr, 
        suggestedParams: await bkr.clients.sandboxAlgod().getTransactionParams().do(),
        assetName: "bar",
        unitName: "foo",
        total: (NUM_USERS * 1e6) + 1e6,
        decimals: 0,
        defaultFrozen: false
      }
    );
    const tCreationSigned = tCreation.signTxn(sandboxAccount.privateKey);
    const {txId} = await bkr.clients.sandboxAlgod().sendRawTransaction(tCreationSigned).do();
    const create_info = await bkr.clients.sandboxAlgod().pendingTransactionInformation(txId).do();
    testAsset = create_info["asset-index"];

    sandboxMockMainClient = new MockMain({
      client: bkr.clients.sandboxAlgod(),
      signer: sandboxAccount.signer,
      sender: sandboxAccount.addr,
    });
    let appCreateResults = await sandboxMockMainClient._create();
    mockMainID = appCreateResults.appId;
    mockMainAddress = appCreateResults.appAddress;

    await compileBeaker("assets/stake_delegator/stake_delegator.py", {GORA_TOKEN_ID: testAsset, MAIN_APP_ID: mockMainID});
    let program = JSON.parse(fs.readFileSync("./assets/stake_delegator/artifacts/application.json", "utf-8"));
    approvalProgram = program.source.approval;
    clearProgram = program.source.clear;
    // Create a new client that will talk to our app
    // Including a signer lets it worry about signing
    // the app call transactions 
    sandboxAppClient = getDelegatorClient({addr: sandboxAccount.addr, sk: sandboxAccount.privateKey});

    appCreateResults = await sandboxAppClient._create({extraPages: 1});
    appId  = appCreateResults.appId;
    appAddress = appCreateResults.appAddress;

    await sendGenericPayment(sandboxAccount.signer, sandboxAccount.addr, mockMainAddress, 1e6);
    await sandboxMockMainClient._optIn();
    await sandboxMockMainClient.init_app({asset: BigInt(testAsset)});

    await compileBeaker("assets/vesting/vesting.py",{MAIN_APP_ID: mockMainID});
    program = JSON.parse(fs.readFileSync("./assets/vesting/artifacts/application.json", "utf-8"));
    approvalProgram = program.source.approval;
    clearProgram = program.source.clear;
    const vestingClient = getVestingClient(
      {addr: sandboxAccount.addr, sk: sandboxAccount.privateKey},
      sandboxMockMainClient.client,
      approvalProgram,
      clearProgram
    );

    appCreateResults = await vestingClient._create({extraPages: 1});

    users = [];
    for(let i = 0; i < NUM_USERS; i++)
    {   
      const user = generateAccount();
      await sendGenericPayment(sandboxAccount.signer, sandboxAccount.addr, user.addr, 1e6);
      await sendGenericAsset(makeBasicAccountTransactionSigner(user), testAsset, user.addr, user.addr, 0);
      await sendGenericAsset(sandboxAccount.signer, testAsset, sandboxAccount.addr, user.addr, 20_000);
      users.push(user);
    }
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
        }),
      vesting_on_behalf_of: globalZeroAddress,
      main_app_ref: BigInt(mockMainID),
      asset_reference: BigInt(testAsset),
      manager_reference: sandboxAccount.addr
    },
    {
      suggestedParams: sp
    }
    );
    const result = await stake.execute(bkr.clients.sandboxAlgod(),5);

    return result;
  }

  async function unstake(amount: number, user: Account) {
    const state = await getGlobal(appId);
    const userClient = getDelegatorClient(user);
    const sp = await userClient.client.getTransactionParams().do();
    sp.flatFee = true;
    sp.fee = 2000;

    const unstake = await userClient.compose.unstake({
      amount_to_withdraw: BigInt(amount),
      main_app_ref: BigInt(mockMainID),
      asset_reference: BigInt(testAsset),
      manager_reference: sandboxAccount.addr
    },
    {
      suggestedParams: sp
    });
    await unstake.execute(bkr.clients.sandboxAlgod(),5);
  }

  it("unable to delete the app", async () => {
    await sendGenericPayment(sandboxAccount.signer, sandboxAccount.addr, appAddress, 1e6);
    await expect(sandboxAppClient._delete()).rejects.toThrow("transaction rejected by ApprovalProgram");
  });

  it("Basic stake, unstake and round iteration", async () => {
    await sendGenericPayment(sandboxAccount.signer, sandboxAccount.addr, appAddress, 500_000);
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
      main_app_id: BigInt(mockMainID),
      main_app_addr: getApplicationAddress(mockMainID),
      manager_address: sandboxAccount.addr,
      manager_algo_share: BigInt(0),
      manager_gora_share: BigInt(0),
      algo_xfer: makePaymentTxnWithSuggestedParamsFromObject({
        from: sandboxAccount.addr,
        suggestedParams: await bkr.clients.sandboxAlgod().getTransactionParams().do(),
        amount: 307_000,
        to: appAddress,
      }),
    },{
      suggestedParams:suggestedParams
    });
    await initApp.execute(bkr.clients.sandboxAlgod(),5);

    //stake through until next round triggers
    await sleep_rounds(1, sandboxAccount);
    for(let i = 0; i < (users.length - 1) && i <= goracle_timelock; i++)
    {
      await stake(10_000, users[i]);
      const state = await getGlobal(appId);
      if(i === users.length - 2 || i === goracle_timelock)
      {
        expect(state["pending_deposits"]).toEqual(0);
      }
      else
      {
        if(i > goracle_timelock)
        {
          expect(state["pending_deposits"]).toEqual(10_000 + ((i - goracle_timelock) * 10_000));
        }
        else
        {
          expect(state["pending_deposits"]).toEqual(10_000 + (i * 10_000));
        }
      }
      expect(state["pending_withdrawals"]).toEqual(0);
    }
    let state = await getGlobal(appId);
    expect(state["aggregation_round"]).toEqual(2);

    //next round should be a withdrawal round, even if users staked, lets have users stake and ensure that the next is withdrawal anyways
    await stake(10_000, users[0]);
    await stake(10_000, users[1]);

    state = await getGlobal(appId);
    expect(state["pending_deposits"]).toEqual(20_000);
    await sleep_rounds(1, sandboxAccount);
    for(let i = 2; i < users.length && i <= goracle_timelock; i++)
    {
      if (i < users.length - 1) {
        await unstake(5_000, users[i]);
      }
      if (i > users.length - 1) {
        await expect(unstake(5_000, users[i])).rejects.toThrow();
      }

      const state = await getGlobal(appId);
      if(i === users.length - 2 || i === goracle_timelock - 1)
      {
        expect(state["pending_withdrawals"]).toEqual(0);
      }
      else
      {
        if(i >= goracle_timelock)
        {
          expect(state["pending_withdrawals"]).toEqual(0);
        }
        else
        {
          expect(state["pending_withdrawals"]).toEqual(5_000 + (i * 5_000) - 10_000);
        }
      }
    }
  });

  it("should not allow user to make more than one stake/unstake action per accumulation round", async () => {
    await sendGenericPayment(sandboxAccount.signer, sandboxAccount.addr, appAddress, 500_000);
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
      main_app_id: BigInt(mockMainID),
      main_app_addr: getApplicationAddress(mockMainID),
      manager_address: sandboxAccount.addr,
      manager_algo_share: BigInt(0),
      manager_gora_share: BigInt(0),
      algo_xfer: makePaymentTxnWithSuggestedParamsFromObject({
        from: sandboxAccount.addr,
        suggestedParams: await bkr.clients.sandboxAlgod().getTransactionParams().do(),
        amount: 307_000,
        to: appAddress,
      }),
    },{
      suggestedParams:suggestedParams,
    });
    await initApp.execute(bkr.clients.sandboxAlgod(),5);

    await stake(5_000, users[0]);
    await expect(stake(5_000, users[0])).rejects.toThrow("assert failed");
    await expect(unstake(5_000, users[0])).rejects.toThrow("assert failed");
  });

  it("should accumulate rewards add to non stake, and then allow users to claim", async () => {
    await sendGenericPayment(sandboxAccount.signer, sandboxAccount.addr, appAddress, 500_000);
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
      main_app_id: BigInt(mockMainID),
      main_app_addr: getApplicationAddress(mockMainID),
      manager_address: sandboxAccount.addr,
      manager_algo_share: BigInt(0),
      manager_gora_share: BigInt(0),
      algo_xfer: makePaymentTxnWithSuggestedParamsFromObject({
        from: sandboxAccount.addr,
        suggestedParams: await bkr.clients.sandboxAlgod().getTransactionParams().do(),
        amount: 307_000,
        to: appAddress,
      }),
    },{
      suggestedParams:suggestedParams,
    });
    const result = await initApp.execute(bkr.clients.sandboxAlgod(),5);

    const foo = await sandboxAppClient.configure_settings({manager_address: sandboxAccount.addr, manager_algo_share: BigInt(200), manager_gora_share: BigInt(100)});
    let amount_staked = 0;
    let users_staked = 0;
    //stake through until next round triggers (time for 8 users to stake on devnet)
    for(let i = 0; i <= 9; i++)
    {
      await stake(10_000, users[i]);
      amount_staked += 10_000;
      await sleep(1_000);
      const dGlobal = await getGlobal(appId);
      //lets give the delegation contract some rewards for round 1 before it rolls over, (this wouldn't happen in real life because aggregation hasn't executed yet, but this allows us to test rewards calculation for users)
      if(dGlobal.aggregation_round == 2)
      {
        await sandboxMockMainClient.mock_local_stake({amount_to_stake: BigInt(amount_staked), account: appAddress});
        users_staked = i;
        const mockMainState = await getMockMainLocal(mockMainID, appAddress);
        await sandboxMockMainClient.mock_rewards({mock_algo: BigInt(mockMainState.rewards.algo_rewards + 100), mock_gora: BigInt(mockMainState.rewards.gora_rewards + 200), account: appAddress});
        await sendGenericAsset(sandboxAccount.signer, testAsset, sandboxAccount.addr, appAddress, 200);
        await sendGenericPayment(sandboxAccount.signer, sandboxAccount.addr, appAddress, 100);
      }
    }
    await sleep_rounds(goracle_timelock * 2, sandboxAccount);
    await stake(0, users[9]); //this will kick off the update of rewards in the contract
    
    const predictedLocal = await getPredictedLocal(appId, mockMainID, users[0].addr);
    const predictedLocal2 = await getPredictedLocal(appId, mockMainID, users[10].addr); // this user didn't get a chance to stake before the round was over
    const dGlobal = await getGlobal(appId);
    //everyone has the same staketime since the "time" element is aggregation rounds and everyone staked during the first aggregation round
    expect(Math.floor(predictedLocal.predicted_rewards_algo)).toEqual(Math.floor((100 / users_staked) * (1 - dGlobal.manager_algo_share)));
    expect(Math.floor(Math.floor(predictedLocal.predicted_rewards_gora))).toEqual(Math.floor((200 / users_staked) * (1 - dGlobal.manager_gora_share)));
    expect(Math.floor(predictedLocal2.predicted_rewards_algo)).toEqual(0);
    expect(Math.floor(predictedLocal2.predicted_rewards_gora)).toEqual(0);

    //claim rewards
    const userClient = getDelegatorClient(users[0]);
    let asset_info_result = await userClient.client.accountAssetInformation(users[0].addr, testAsset).do();
    let assetBalance_pre = asset_info_result["asset-holding"]["amount"];
    let account_info_result = await userClient.client.accountInformation(users[0].addr).do();
    const algo_balance_pre = account_info_result["amount"];

    const sp = await userClient.client.getTransactionParams().do();
    sp.flatFee = true;
    sp.fee = 4000;

    const claim_result = await userClient.user_claim(
      {
        asset_reference: BigInt(testAsset),
        main_app_reference: BigInt(mockMainID),
        manager_reference: sandboxAccount.addr
      },
      {
        suggestedParams: sp
      });
    asset_info_result = await userClient.client.accountAssetInformation(users[0].addr, testAsset).do();
    let assetBalance_post = asset_info_result["asset-holding"]["amount"];
    account_info_result = await userClient.client.accountInformation(users[0].addr).do();
    const algo_balance_post = account_info_result["amount"];
    
    expect(Math.round(2000 + algo_balance_post - algo_balance_pre)).toEqual(-1992); //2k because 2 txns (one is an opup)
    expect(Math.round(assetBalance_post - assetBalance_pre)).toEqual(20);

    await sleep_rounds(goracle_timelock, sandboxAccount);
    //unstake 
    await unstake(10_000, users[0]);

    await sleep_rounds(goracle_timelock, sandboxAccount);

    asset_info_result = await userClient.client.accountAssetInformation(users[0].addr, testAsset).do();
    assetBalance_pre = asset_info_result["asset-holding"]["amount"];

    //next transaction is going to try to withdraw from mockmain, which doesn't implement actual withdrawal mechanisms, so lets stage the funds.
    await sendGenericAsset(sandboxAccount.signer, testAsset, sandboxAccount.addr, appAddress, 10_000);

    const withdrawNonStake = await userClient.compose.withdraw_non_stake({
      vesting_on_behalf_of: globalZeroAddress,
      goracle_token_reference: BigInt(testAsset),
      main_app_reference: BigInt(mockMainID),
      manager_reference: sandboxAccount.addr
    },
    {
      suggestedParams: sp
    });
    await withdrawNonStake.execute(userClient.client,5);

    asset_info_result = await userClient.client.accountAssetInformation(users[0].addr, testAsset).do();
    assetBalance_post = asset_info_result["asset-holding"]["amount"];
    expect(assetBalance_post - assetBalance_pre).toEqual(10_000);

    
    // restake, this was put here to test an issue where restaking caused a crash cause local aggregation tracker wasn't reset
    await stake(10_000, users[0]);

  });

  it("manager key registration", async () => {
    await sendGenericPayment(sandboxAccount.signer, sandboxAccount.addr, appAddress, 500_000);
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
    const sp = await getSuggestedParams();
    const initApp = await sandboxAppClient.compose.init_app({
      asset: BigInt(testAsset),
      timelock: BigInt(goracle_timelock),
      main_app_id: BigInt(mockMainID),
      main_app_addr: getApplicationAddress(mockMainID),
      manager_address: sandboxAccount.addr,
      manager_algo_share: BigInt(0),
      manager_gora_share: BigInt(0),
      algo_xfer: makePaymentTxnWithSuggestedParamsFromObject({
        from: sandboxAccount.addr,
        suggestedParams: await bkr.clients.sandboxAlgod().getTransactionParams().do(),
        amount: 307_000,
        to: appAddress,
      }),
    },{
      suggestedParams:{
        ...sp,
        flatFee: true,
        fee: 3000
      }
    });
    await initApp.execute(bkr.clients.sandboxAlgod(),5);

    //should not allow non manager to change participation key
    const userClient = getDelegatorClient(users[0]);
  
    await expect(userClient.register_participation_key({new_key: users[0].addr, main_ref: BigInt(mockMainID)})).rejects.toThrow("assert failed");
    
    //should allow manager to register
    const registerManagerKey = await sandboxAppClient.compose.register_participation_key(
      {
        new_key: users[0].addr,
        main_ref: BigInt(mockMainID)
      },
      {
        suggestedParams:{
          ...sp,
          flatFee: true,
          fee: 2000
        }
      }
    );
    expect(await registerManagerKey.execute(bkr.clients.sandboxAlgod(),5));
  });
});
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

describe("Vesting Tests", () => {
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
    
    const delegator_info = await deploy_delegator(
      testAsset,
      sandboxAccount,
      mainAppId,
      mainAppAddress
    );
    delegator_app_id = delegator_info["delegator_app_id"];
    delegator_app_addr = delegator_info["delegator_app_addr"];

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

    const appCreateResults = await sandboxAppClient._create({extraPages: 1});
    appId  = appCreateResults.appId;
    appAddress = appCreateResults.appAddress;

    users = [];
    for(let i = 0; i < NUM_USERS; i++)
    {   
      const user = generateAccount();
      await sendGenericPayment(sandboxAccount.signer, sandboxAccount.addr, user.addr, 1e6);
      await sendGenericAsset(makeBasicAccountTransactionSigner(user), testAsset, user.addr, user.addr, 0);
      await sendGenericAsset(sandboxAccount.signer, testAsset, sandboxAccount.addr, user.addr, 20_000);
      users.push(user);
    }
    await sendGenericPayment(sandboxAccount.signer, sandboxAccount.addr, appAddress, 100_000);
  });
  
  it("unable to delete the app", async () => {
    await sendGenericPayment(sandboxAccount.signer, sandboxAccount.addr, appAddress, 1e6);
    await expect(sandboxAppClient._delete()).rejects.toThrow("transaction rejected by ApprovalProgram");
  });

  it("able to vest tokens to user", async () => {
    const optin_algo_transferTxn = {
      txn: makePaymentTxnWithSuggestedParamsFromObject({
        from: users[0].addr,
        suggestedParams: await algodClient.getTransactionParams().do(),
        amount: 100_000,
        to: appAddress,
      }),
      signer: makeBasicAccountTransactionSigner(users[0])
    };
    let suggestedParams = await algodClient.getTransactionParams().do();
    suggestedParams.flatFee = true;
    suggestedParams.fee = 2000;
    const optinAsset = await sandboxAppClient.compose.optin_asset(
      {
        algo_xfer: optin_algo_transferTxn,
        asset: BigInt(testAsset),
        main_app_id: BigInt(mainAppId),
        main_app_addr: getApplicationAddress(mainAppId)
      },
      {
        suggestedParams: suggestedParams
      }
    );
    await optinAsset.execute(algodClient,5);

    let algo_transferTxn = {
      txn: makePaymentTxnWithSuggestedParamsFromObject({
        from: users[0].addr,
        suggestedParams: await algodClient.getTransactionParams().do(),
        amount: 57_300,
        to: appAddress,
      }),
      signer: makeBasicAccountTransactionSigner(users[0])
    };

    let token_transferTxn = {
      txn: makeAssetTransferTxnWithSuggestedParamsFromObject({
        from: users[0].addr,
        suggestedParams: await algodClient.getTransactionParams().do(),
        amount: 1000,
        to: appAddress,
        assetIndex: testAsset
      }),
      signer: makeBasicAccountTransactionSigner(users[0])
    };
    const asset_64 = new ABIUintType(64);
    const key = new Uint8Array(Buffer.from("goracle_vesting"));
    const key_hash = new Uint8Array(sha512_256.arrayBuffer([...asset_64.encode(testAsset), ...decodeAddress(sandboxAccount.addr).publicKey, ...key]));
    const vestingKey = VestingKey.encode([users[1].addr, key_hash]);

    const vestTokens = await sandboxAppClient.compose.vest_tokens(
      {
        algo_xfer: algo_transferTxn,
        token_xfer: token_transferTxn,
        vest_to: users[1].addr,
        vesting_key: key,
        time_to_vest: BigInt(100)
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

    let vestings = await getVestings(appId, users[1].addr);
    expect(vestings[0].token_id).toEqual(testAsset);
    expect(vestings[0].staked).toEqual(false);
    expect(vestings[0].amount).toEqual(1000);

    // we are going to attempt to vest again for the same user and will expect this to fail

    algo_transferTxn = {
      txn: makePaymentTxnWithSuggestedParamsFromObject({
        from: users[0].addr,
        suggestedParams: await algodClient.getTransactionParams().do(),
        amount: 0,
        to: appAddress,
      }),
      signer: makeBasicAccountTransactionSigner(users[0])
    };

    token_transferTxn = {
      txn: makeAssetTransferTxnWithSuggestedParamsFromObject({
        from: users[0].addr,
        suggestedParams: await algodClient.getTransactionParams().do(),
        amount: 1000,
        to: appAddress,
        assetIndex: testAsset
      }),
      signer: makeBasicAccountTransactionSigner(users[0])
    };

    const vestTokensAgain = await sandboxAppClient.compose.vest_tokens(
      {
        algo_xfer: algo_transferTxn,
        token_xfer: token_transferTxn,
        vest_to: users[1].addr,
        vesting_key: key,
        time_to_vest: BigInt(100)
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
    await expect(vestTokensAgain.execute(algodClient,5)).rejects.toThrow("assert failed");

    // Record the initial pre-balance to compare against final post-balance
    let asset_info_result = await algodClient.accountAssetInformation(users[1].addr, testAsset).do();
    const initialAssetBalance_pre = asset_info_result["asset-holding"]["amount"];

    // Wait halfway through vesting period
    await sleep_rounds(1, sandboxAccount);

    // devnet iterates 25 seconds per transaction, should be able to get 50% here
    asset_info_result = await algodClient.accountAssetInformation(users[1].addr, testAsset).do();
    let assetBalance_pre = asset_info_result["asset-holding"]["amount"];

    suggestedParams = await algodClient.getTransactionParams().do();
    suggestedParams.flatFee = true;
    suggestedParams.fee = 2000;
    let claimVesting = await sandboxAppClient.compose.claim_vesting({
      vestee: users[1].addr,
      key_hash: key_hash,
      asset_ref: BigInt(testAsset),
      receiver_ref: users[1].addr,
    },
    {
      boxes: [
        {
          name: vestingKey,
          appIndex: appId
        }
      ],
      suggestedParams: suggestedParams
    });
    await claimVesting.execute(algodClient,5);

    vestings = await getVestings(appId, users[1].addr);
    // print bal post
    asset_info_result = await algodClient.accountAssetInformation(users[1].addr, testAsset).do();
    let assetBalance_post = asset_info_result["asset-holding"]["amount"];
    expect(assetBalance_post - assetBalance_pre).toEqual(500);

    // wait another 25 seconds  
    asset_info_result = await algodClient.accountAssetInformation(users[1].addr, testAsset).do();
    assetBalance_pre = asset_info_result["asset-holding"]["amount"];

    suggestedParams = await algodClient.getTransactionParams().do();
    suggestedParams.flatFee = true;
    suggestedParams.fee = 2000;
    claimVesting = await sandboxAppClient.compose.claim_vesting({
      vestee: users[1].addr,
      key_hash: key_hash,
      asset_ref: BigInt(testAsset),
      receiver_ref: users[1].addr
    },
    {
      boxes: [
        {
          name: vestingKey,
          appIndex: appId
        }
      ],
      suggestedParams: suggestedParams
    });
    await claimVesting.execute(algodClient,5);

    asset_info_result = await algodClient.accountAssetInformation(users[1].addr, testAsset).do();
    assetBalance_post = asset_info_result["asset-holding"]["amount"];
    expect(assetBalance_post - initialAssetBalance_pre).toEqual(750);

    vestings = await getVestings(appId, users[1].addr);
    //should be final claim
    suggestedParams = await algodClient.getTransactionParams().do();
    suggestedParams.flatFee = true;
    suggestedParams.fee = 3000;
    claimVesting = await sandboxAppClient.compose.claim_vesting({
      vestee: users[1].addr,
      key_hash: key_hash,
      asset_ref: BigInt(testAsset),
      receiver_ref: users[1].addr
    },
    {
      boxes: [
        {
          name: vestingKey,
          appIndex: appId
        }
      ],
      suggestedParams:suggestedParams
    });
    await claimVesting.execute(algodClient,5);

    asset_info_result = await algodClient.accountAssetInformation(users[1].addr, testAsset).do();
    assetBalance_post = asset_info_result["asset-holding"]["amount"];
    expect(assetBalance_post - initialAssetBalance_pre).toEqual(1000);

    suggestedParams = await algodClient.getTransactionParams().do();
    suggestedParams.flatFee = true;
    suggestedParams.fee = 3000;
    claimVesting = await sandboxAppClient.compose.claim_vesting({
      vestee: users[1].addr,
      key_hash: key_hash,
      asset_ref: BigInt(testAsset),
      receiver_ref: users[1].addr
    },
    {
      boxes: [
        {
          name: vestingKey,
          appIndex: appId
        }
      ],
      suggestedParams:suggestedParams
    });
    // this should crash
    await expect(claimVesting.execute(algodClient,5)).rejects.toThrow("assert failed");
  });

  it("able to stake tokens to delegation app", async () => {
    const optin_algo_transferTxn = {
      txn: makePaymentTxnWithSuggestedParamsFromObject({
        from: users[0].addr,
        suggestedParams: await algodClient.getTransactionParams().do(),
        amount: 100_000,
        to: appAddress,
      }),
      signer: makeBasicAccountTransactionSigner(users[0])
    };
    let suggestedParams = await algodClient.getTransactionParams().do();
    suggestedParams.flatFee = true;
    suggestedParams.fee = 2000;
    const optinAsset = await sandboxAppClient.compose.optin_asset(
      {
        algo_xfer: optin_algo_transferTxn,
        asset: BigInt(testAsset),
        main_app_id: BigInt(mainAppId),
        main_app_addr: getApplicationAddress(mainAppId)
      },
      {
        suggestedParams: suggestedParams
      }
    );
    await optinAsset.execute(algodClient,5);

    const algo_transferTxn = {
      txn: makePaymentTxnWithSuggestedParamsFromObject({
        from: users[0].addr,
        suggestedParams: await algodClient.getTransactionParams().do(),
        amount: 57_300,
        to: appAddress,
      }),
      signer: makeBasicAccountTransactionSigner(users[0])
    };
    const vestAmount = 1000;
    const token_transferTxn = {
      txn: makeAssetTransferTxnWithSuggestedParamsFromObject({
        from: users[0].addr,
        suggestedParams: await algodClient.getTransactionParams().do(),
        amount: 1000,
        to: appAddress,
        assetIndex: testAsset
      }),
      signer: makeBasicAccountTransactionSigner(users[0])
    };
    const asset_64 = new ABIUintType(64);
    const key = new Uint8Array(Buffer.from("goracle_vesting"));
    const key_hash = new Uint8Array(sha512_256.arrayBuffer([...asset_64.encode(testAsset), ...decodeAddress(sandboxAccount.addr).publicKey, ...key]));
    const vestingKey = VestingKey.encode([users[1].addr, key_hash]);

    const vestTokens = await sandboxAppClient.compose.vest_tokens({
      algo_xfer: algo_transferTxn,
      token_xfer: token_transferTxn,
      vest_to: users[1].addr,
      vesting_key: key,
      time_to_vest: BigInt(30)
    },
    {
      boxes: [
        {
          name: vestingKey,
          appIndex: appId
        }
      ]
    });
    await vestTokens.execute(algodClient,5);
    
    const userClient = new Vesting({
      client: bkr.clients.sandboxAlgod(),
      signer: makeBasicAccountTransactionSigner(users[1]),
      sender: users[1].addr,
      appId: appId
    });

    const userDelegatorClient = new StakeDelegator({
      client: algodClient,
      signer: makeBasicAccountTransactionSigner(users[1]),
      sender: users[1].addr,
      appId: delegator_app_id
    });

    optInMethod = getMethodByName(userDelegatorClient.methods,"opt_in");
    await userDelegatorClient._optIn({
      appArgs: [
        optInMethod.getSelector(),
        encodeUint64(appId)
      ]
    });

    const delegator_global_state = await delegatorGetGlobal(delegator_app_id);
    const whitelist_name = new ABIUintType(64).encode(delegator_app_id);
    //attempt to stake when app hasn't been added to whitelist

    let stakeToDelegator = await userClient.compose.stake_to_delegator({
      delegator: BigInt(delegator_app_id),
      key_hash: key_hash,
      main_app_ref: BigInt(mainAppId),
      asset_reference: BigInt(testAsset),
      manager_reference: delegator_global_state["manager_address"]
    },
    {
      boxes: [
        {
          name: vestingKey,
          appIndex: appId
        },
        {
          name: whitelist_name,
          appIndex: appId
        }
      ]
    });
    await expect(stakeToDelegator.execute(algodClient,5)).rejects.toThrow("assert failed");

    //stake when app has been added to whitelist
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

    let asset_info_result = await algodClient.accountAssetInformation(mainAppAddress, testAsset).do();
    const main_assetBalance_pre = asset_info_result["asset-holding"]["amount"];
    let sp = await algodClient.getTransactionParams().do();
    sp = {
      ...sp,
      flatFee: true,
      fee: 3000
    };
    
    stakeToDelegator = await userClient.compose.stake_to_delegator({
      delegator: BigInt(delegator_app_id),
      key_hash: key_hash,
      main_app_ref: BigInt(mainAppId),
      asset_reference: BigInt(testAsset),
      manager_reference: delegator_global_state["manager_address"]
    },
    {
      "suggestedParams": sp,
      boxes: [
        {
          name: vestingKey,
          appIndex: appId
        },
        {
          name: whitelist_name,
          appIndex: appId
        }
      ]
    });
    await stakeToDelegator.execute(algodClient,5);

    // funds end up moving to main app right away
    asset_info_result = await algodClient.accountAssetInformation(mainAppAddress, testAsset).do();
    const main_assetBalance_post = asset_info_result["asset-holding"]["amount"];
    expect(main_assetBalance_post - main_assetBalance_pre).toEqual(1000);
    const selfStakeAmount = 1000;
    const stake = await userDelegatorClient.compose.stake({
      asset_pay: makeAssetTransferTxnWithSuggestedParamsFromObject(
        {
          from: users[1].addr, 
          to: delegator_app_addr,
          amount: selfStakeAmount,
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
      suggestedParams:{
        ...await userClient.client.getTransactionParams().do(),
        flatFee: true,
        fee: 4000
      }
    });
    const result = await stake.execute(algodClient,5);    

    // wait out goracle timeout
    await sleep_rounds(10, sandboxAccount);
    sp = await algodClient.getTransactionParams().do();
    sp = {
      ...sp,
      flatFee: true,
      fee: 2000
    };
    let manualProcessAggregation = await userDelegatorClient.compose.manual_process_aggregation(
      {
        asset_reference: BigInt(testAsset),
        main_app_reference: BigInt(mainAppId),
        manager_reference: delegator_global_state["manager_address"], 
      },
      {
        "suggestedParams": sp
      }
    );
    await manualProcessAggregation.execute(algodClient,5);

    const delegatorLocal = await delegatorGetLocal(delegator_app_id, users[1].addr);
    
    //can unstake directly from delegation app (this doesn't withdraw funds)
    // this will fail as a vested staker is trying unstake less than the amount staked with the vesting contract
    let unstake = await userDelegatorClient.compose.unstake(
      {
        amount_to_withdraw: BigInt(999),
        main_app_ref: BigInt(mainAppId),
        asset_reference: BigInt(testAsset),
        manager_reference: delegator_global_state["manager_address"]
      },
      {
        "suggestedParams": sp
      }
    );

    await expect(unstake.execute(algodClient,5)).rejects.toThrow("assert failed");
    const unstakeAmount = 1500;
    unstake = await userDelegatorClient.compose.unstake(
      {
        amount_to_withdraw: BigInt(unstakeAmount),
        main_app_ref: BigInt(mainAppId),
        asset_reference: BigInt(testAsset),
        manager_reference: delegator_global_state["manager_address"]
      },
      {
        "suggestedParams": sp
      }
    );

    await unstake.execute(algodClient,5);

    //have to wait until next aggregation to actually get funds
    await sleep_rounds(10, sandboxAccount);
    sp = await algodClient.getTransactionParams().do();
    sp = {
      ...sp,
      flatFee: true,
      fee: 2000
    };
    manualProcessAggregation = await userDelegatorClient.compose.manual_process_aggregation(
      {
        asset_reference: BigInt(testAsset),
        main_app_reference: BigInt(mainAppId),
        manager_reference: delegator_global_state["manager_address"], 
      },
      {
        "suggestedParams": sp
      }
    );
    await manualProcessAggregation.execute(algodClient,5);

    //cannot withdraw vested funds from delegation app
    sp = await algodClient.getTransactionParams().do();
    sp = {
      ...sp,
      flatFee: true,
      fee: 4000
    };
    const userAssetAmountPre = await algodClient.accountAssetInformation(users[1].addr,testAsset).do();
    const withDrawNonStake = await userDelegatorClient.compose.withdraw_non_stake(
      {
        vesting_on_behalf_of: globalZeroAddress,
        main_app_reference: BigInt(mainAppId),
        goracle_token_reference: BigInt(testAsset),
        manager_reference: delegator_global_state["manager_address"]
      },
      {
        suggestedParams:sp
      }
    );
    await withDrawNonStake.execute(algodClient,5);
    const userAssetAmountPost = await algodClient.accountAssetInformation(users[1].addr,testAsset).do();
    expect(
      userAssetAmountPost["asset-holding"]["amount"] - userAssetAmountPre["asset-holding"]["amount"]
    ).toEqual(
      selfStakeAmount + vestAmount - unstakeAmount
    );

    asset_info_result = await algodClient.accountAssetInformation(appAddress, testAsset).do();
    const assetBalance_pre = asset_info_result["asset-holding"]["amount"];
    suggestedParams = await algodClient.getTransactionParams().do();
    suggestedParams.flatFee = true;
    suggestedParams.fee = 3000;
    const withDrawFromDelegator = await userClient.compose.withdraw_from_delegator(
      {
        delegator: BigInt(delegator_app_id),
        key_hash: key_hash,
        main_app_ref: BigInt(mainAppId),
        asset_reference: BigInt(testAsset),
        manager_reference: delegator_global_state["manager_address"]
      },
      {
        boxes: [
          {
            name: vestingKey,
            appIndex: appId
          },
          {
            name: whitelist_name,
            appIndex: appId
          }
        ],
        suggestedParams:suggestedParams
      }
    );
    await withDrawFromDelegator.execute(algodClient,5);

    asset_info_result = await algodClient.accountAssetInformation(appAddress, testAsset).do();
    const assetBalance_post = asset_info_result["asset-holding"]["amount"];
    expect(assetBalance_post - assetBalance_pre).toEqual(1000);

    const vestings = await getVestings(appId, users[1].addr);
    expect(vestings[0].staked).toEqual(false);
  });

  it("able to stake tokens to delegation app without separate delegation", async () => {
    const optin_algo_transferTxn = {
      txn: makePaymentTxnWithSuggestedParamsFromObject({
        from: users[0].addr,
        suggestedParams: await algodClient.getTransactionParams().do(),
        amount: 100_000,
        to: appAddress,
      }),
      signer: makeBasicAccountTransactionSigner(users[0])
    };
    let suggestedParams = await algodClient.getTransactionParams().do();
    suggestedParams.flatFee = true;
    suggestedParams.fee = 2000;
    const optinAsset = await sandboxAppClient.compose.optin_asset(
      {
        algo_xfer: optin_algo_transferTxn,
        asset: BigInt(testAsset),
        main_app_id: BigInt(mainAppId),
        main_app_addr: getApplicationAddress(mainAppId)
      },
      {
        suggestedParams: suggestedParams
      }
    );
    await optinAsset.execute(algodClient,5);

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
        amount: 1000,
        to: appAddress,
        assetIndex: testAsset
      }),
      signer: makeBasicAccountTransactionSigner(users[0])
    };
    const asset_64 = new ABIUintType(64);
    const key = new Uint8Array(Buffer.from("goracle_vesting"));
    const key_hash = new Uint8Array(sha512_256.arrayBuffer([...asset_64.encode(testAsset), ...decodeAddress(sandboxAccount.addr).publicKey, ...key]));
    const vestingKey = VestingKey.encode([users[1].addr, key_hash]);

    const vestTokens = await sandboxAppClient.compose.vest_tokens({
      algo_xfer: algo_transferTxn,
      token_xfer: token_transferTxn,
      vest_to: users[1].addr,
      vesting_key: key,
      time_to_vest: BigInt(30)
    },
    {
      boxes: [
        {
          name: vestingKey,
          appIndex: appId
        }
      ]
    });
    await vestTokens.execute(algodClient,5);
    
    const userClient = new Vesting({
      client: bkr.clients.sandboxAlgod(),
      signer: makeBasicAccountTransactionSigner(users[1]),
      sender: users[1].addr,
      appId: appId
    });

    const userDelegatorClient = new StakeDelegator({
      client: algodClient,
      signer: makeBasicAccountTransactionSigner(users[1]),
      sender: users[1].addr,
      appId: delegator_app_id
    });

    optInMethod = getMethodByName(userDelegatorClient.methods,"opt_in");
    await userDelegatorClient._optIn({
      appArgs: [
        optInMethod.getSelector(),
        encodeUint64(appId)
      ]
    });

    const delegator_global_state = await delegatorGetGlobal(delegator_app_id);
    const whitelist_name = new ABIUintType(64).encode(delegator_app_id);
    //attempt to stake when app hasn't been added to whitelist

    let stakeToDelegator = await userClient.compose.stake_to_delegator({
      delegator: BigInt(delegator_app_id),
      key_hash: key_hash,
      main_app_ref: BigInt(mainAppId),
      asset_reference: BigInt(testAsset),
      manager_reference: delegator_global_state["manager_address"]
    },
    {
      boxes: [
        {
          name: vestingKey,
          appIndex: appId
        },
        {
          name: whitelist_name,
          appIndex: appId
        }
      ]
    });
    await expect(stakeToDelegator.execute(algodClient,5)).rejects.toThrow("assert failed");

    //stake when app has been added to whitelist
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

    let asset_info_result = await algodClient.accountAssetInformation(mainAppAddress, testAsset).do();
    const main_assetBalance_pre = asset_info_result["asset-holding"]["amount"];
    let sp = await algodClient.getTransactionParams().do();
    sp = {
      ...sp,
      flatFee: true,
      fee: 3000
    };
    
    stakeToDelegator = await userClient.compose.stake_to_delegator({
      delegator: BigInt(delegator_app_id),
      key_hash: key_hash,
      main_app_ref: BigInt(mainAppId),
      asset_reference: BigInt(testAsset),
      manager_reference: delegator_global_state["manager_address"]
    },
    {
      "suggestedParams": sp,
      boxes: [
        {
          name: vestingKey,
          appIndex: appId
        },
        {
          name: whitelist_name,
          appIndex: appId
        }
      ]
    });
    await stakeToDelegator.execute(algodClient,5);

    // funds end up moving to main app right away
    asset_info_result = await algodClient.accountAssetInformation(mainAppAddress, testAsset).do();
    const main_assetBalance_post = asset_info_result["asset-holding"]["amount"];
    expect(main_assetBalance_post - main_assetBalance_pre).toEqual(1000);  

    // wait out goracle timeout
    await sleep_rounds(10, sandboxAccount);
    sp = await algodClient.getTransactionParams().do();
    sp = {
      ...sp,
      flatFee: true,
      fee: 2000
    };
    let manualProcessAggregation = await userDelegatorClient.compose.manual_process_aggregation(
      {
        asset_reference: BigInt(testAsset),
        main_app_reference: BigInt(mainAppId),
        manager_reference: delegator_global_state["manager_address"], 
      },
      {
        "suggestedParams": sp
      }
    );
    await manualProcessAggregation.execute(algodClient,5);

    const delegatorLocal = await delegatorGetLocal(delegator_app_id, users[1].addr);
    
    //can unstake directly from delegation app (this doesn't withdraw funds)
    // this will fail as a vested staker is trying unstake less than the amount staked with the vesting contract
    let unstake = await userDelegatorClient.compose.unstake(
      {
        amount_to_withdraw: BigInt(999),
        main_app_ref: BigInt(mainAppId),
        asset_reference: BigInt(testAsset),
        manager_reference: delegator_global_state["manager_address"]
      },
      {
        "suggestedParams": sp
      }
    );

    await expect(unstake.execute(algodClient,5)).rejects.toThrow("assert failed");

    // this will fail as a vested staker is trying unstake more than the amount staked with the vesting contract
    unstake = await userDelegatorClient.compose.unstake(
      {
        amount_to_withdraw: BigInt(1001),
        main_app_ref: BigInt(mainAppId),
        asset_reference: BigInt(testAsset),
        manager_reference: delegator_global_state["manager_address"]
      },
      {
        "suggestedParams": sp
      }
    );

    await expect(unstake.execute(algodClient,5)).rejects.toThrow("assert failed");

    unstake = await userDelegatorClient.compose.unstake(
      {
        amount_to_withdraw: BigInt(1000),
        main_app_ref: BigInt(mainAppId),
        asset_reference: BigInt(testAsset),
        manager_reference: delegator_global_state["manager_address"]
      },
      {
        "suggestedParams": sp
      }
    );

    await unstake.execute(algodClient,5);

    //have to wait until next aggregation to actually get funds
    await sleep_rounds(10, sandboxAccount);
    sp = await algodClient.getTransactionParams().do();
    sp = {
      ...sp,
      flatFee: true,
      fee: 2000
    };
    manualProcessAggregation = await userDelegatorClient.compose.manual_process_aggregation(
      {
        asset_reference: BigInt(testAsset),
        main_app_reference: BigInt(mainAppId),
        manager_reference: delegator_global_state["manager_address"], 
      },
      {
        "suggestedParams": sp
      }
    );
    await manualProcessAggregation.execute(algodClient,5);

    //cannot withdraw vested funds from delegation app
    sp = await algodClient.getTransactionParams().do();
    sp = {
      ...sp,
      flatFee: true,
      fee: 4000
    };
    const withDrawNonStake = await userDelegatorClient.compose.withdraw_non_stake(
      {
        vesting_on_behalf_of: globalZeroAddress,
        main_app_reference: BigInt(mainAppId),
        goracle_token_reference: BigInt(testAsset),
        manager_reference: delegator_global_state["manager_address"]
      },
      {
        suggestedParams:sp
      }
    );
    await expect(withDrawNonStake.execute(algodClient,5)).rejects.toThrow("assert failed");

    asset_info_result = await algodClient.accountAssetInformation(appAddress, testAsset).do();
    const assetBalance_pre = asset_info_result["asset-holding"]["amount"];
    suggestedParams = await algodClient.getTransactionParams().do();
    suggestedParams.flatFee = true;
    suggestedParams.fee = 3000;
    const withDrawFromDelegator = await userClient.compose.withdraw_from_delegator(
      {
        delegator: BigInt(delegator_app_id),
        key_hash: key_hash,
        main_app_ref: BigInt(mainAppId),
        asset_reference: BigInt(testAsset),
        manager_reference: delegator_global_state["manager_address"]
      },
      {
        boxes: [
          {
            name: vestingKey,
            appIndex: appId
          },
          {
            name: whitelist_name,
            appIndex: appId
          }
        ],
        suggestedParams:suggestedParams
      }
    );
    await withDrawFromDelegator.execute(algodClient,5);

    asset_info_result = await algodClient.accountAssetInformation(appAddress, testAsset).do();
    const assetBalance_post = asset_info_result["asset-holding"]["amount"];
    expect(assetBalance_post - assetBalance_pre).toEqual(1000);

    const vestings = await getVestings(appId, users[1].addr);
    expect(vestings[0].staked).toEqual(false);
  });

  it("shouldn't allow a user to claim_vesting staked amount", async () => {
    const optin_algo_transferTxn = {
      txn: makePaymentTxnWithSuggestedParamsFromObject({
        from: users[0].addr,
        suggestedParams: await algodClient.getTransactionParams().do(),
        amount: 100_000,
        to: appAddress,
      }),
      signer: makeBasicAccountTransactionSigner(users[0])
    };
    const suggestedParams = await algodClient.getTransactionParams().do();
    suggestedParams.flatFee = true;
    suggestedParams.fee = 2000;
    const optinAsset = await sandboxAppClient.compose.optin_asset(
      {
        algo_xfer: optin_algo_transferTxn,
        asset: BigInt(testAsset),
        main_app_id: BigInt(mainAppId),
        main_app_addr: getApplicationAddress(mainAppId)
      },
      {
        suggestedParams: suggestedParams
      }
    );
    await optinAsset.execute(algodClient,5);

    const algo_transferTxn = {
      txn: makePaymentTxnWithSuggestedParamsFromObject({
        from: users[0].addr,
        suggestedParams: await algodClient.getTransactionParams().do(),
        amount: 57_300,
        to: appAddress,
      }),
      signer: makeBasicAccountTransactionSigner(users[0])
    };
    const vestedAmount = 2000;
    const token_transferTxn = {
      txn: makeAssetTransferTxnWithSuggestedParamsFromObject({
        from: users[0].addr,
        suggestedParams: await algodClient.getTransactionParams().do(),
        amount: vestedAmount,
        to: appAddress,
        assetIndex: testAsset
      }),
      signer: makeBasicAccountTransactionSigner(users[0])
    };
    const asset_64 = new ABIUintType(64);
    const key = new Uint8Array(Buffer.from("goracle_vesting"));
    const key_hash = new Uint8Array(sha512_256.arrayBuffer([...asset_64.encode(testAsset), ...decodeAddress(sandboxAccount.addr).publicKey, ...key]));
    const vestingKey = VestingKey.encode([users[1].addr, key_hash]);

    const vestTokens = await sandboxAppClient.compose.vest_tokens({
      algo_xfer: algo_transferTxn,
      token_xfer: token_transferTxn,
      vest_to: users[1].addr,
      vesting_key: key,
      time_to_vest: BigInt(30)
    },
    {
      boxes: [
        {
          name: vestingKey,
          appIndex: appId
        }
      ]
    });
    await vestTokens.execute(algodClient,5);
    
    const userClient = new Vesting({
      client: bkr.clients.sandboxAlgod(),
      signer: makeBasicAccountTransactionSigner(users[1]),
      sender: users[1].addr,
      appId: appId
    });

    const userDelegatorClient = new StakeDelegator({
      client: algodClient,
      signer: makeBasicAccountTransactionSigner(users[1]),
      sender: users[1].addr,
      appId: delegator_app_id
    });

    optInMethod = getMethodByName(userDelegatorClient.methods,"opt_in");
    await userDelegatorClient._optIn({
      appArgs: [
        optInMethod.getSelector(),
        encodeUint64(appId)
      ]
    });

    const delegator_global_state = await delegatorGetGlobal(delegator_app_id);
    const whitelist_name = new ABIUintType(64).encode(delegator_app_id);
    //attempt to stake when app hasn't been added to whitelist

    let stakeToDelegator = await userClient.compose.stake_to_delegator({
      delegator: BigInt(delegator_app_id),
      key_hash: key_hash,
      main_app_ref: BigInt(mainAppId),
      asset_reference: BigInt(testAsset),
      manager_reference: delegator_global_state["manager_address"]
    },
    {
      boxes: [
        {
          name: vestingKey,
          appIndex: appId
        },
        {
          name: whitelist_name,
          appIndex: appId
        }
      ]
    });
    await expect(stakeToDelegator.execute(algodClient,5)).rejects.toThrow("assert failed");

    //stake when app has been added to whitelist
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

    let asset_info_result = await algodClient.accountAssetInformation(mainAppAddress, testAsset).do();
    const main_assetBalance_pre = asset_info_result["asset-holding"]["amount"];
    let sp = await algodClient.getTransactionParams().do();
    sp = {
      ...sp,
      flatFee: true,
      fee: 3000
    };
    
    stakeToDelegator = await userClient.compose.stake_to_delegator({
      delegator: BigInt(delegator_app_id),
      key_hash: key_hash,
      main_app_ref: BigInt(mainAppId),
      asset_reference: BigInt(testAsset),
      manager_reference: delegator_global_state["manager_address"]
    },
    {
      "suggestedParams": sp,
      boxes: [
        {
          name: vestingKey,
          appIndex: appId
        },
        {
          name: whitelist_name,
          appIndex: appId
        }
      ]
    });
    await stakeToDelegator.execute(algodClient,5);

    // funds end up moving to main app right away
    asset_info_result = await algodClient.accountAssetInformation(mainAppAddress, testAsset).do();
    const main_assetBalance_post = asset_info_result["asset-holding"]["amount"];
    expect(main_assetBalance_post - main_assetBalance_pre).toEqual(vestedAmount);
    

    // wait out goracle timeout
    await sleep_rounds(10, sandboxAccount);
    sp = await algodClient.getTransactionParams().do();
    sp = {
      ...sp,
      flatFee: true,
      fee: 2000
    };
    const manualProcessAggregation = await userDelegatorClient.compose.manual_process_aggregation(
      {
        asset_reference: BigInt(testAsset),
        main_app_reference: BigInt(mainAppId),
        manager_reference: delegator_global_state["manager_address"], 
      },
      {
        "suggestedParams": sp
      }
    );
    await manualProcessAggregation.execute(algodClient,5);

    const delegatorLocal = await delegatorGetLocal(delegator_app_id, users[1].addr);
    asset_info_result = await algodClient.accountAssetInformation(users[1].addr, testAsset).do();
    const assetBalance_pre = asset_info_result["asset-holding"]["amount"];
    fundAccount(users[1].addr,1e9);
    fundAccount(userClient.appAddress,1e9);
    await sendGenericAsset(sandboxAccount.signer, testAsset, sandboxAccount.addr, userClient.appAddress, 20_000);
    
    const claimVestingDuringStake = await userClient.compose.claim_vesting({
      vestee: users[1].addr,
      key_hash: key_hash,
      asset_ref: BigInt(testAsset),
      receiver_ref: users[1].addr
    },
    {
      boxes: [
        {
          name: vestingKey,
          appIndex: appId
        }
      ],
      suggestedParams:{
        ...suggestedParams,
        flatFee:true,
        fee: 3000
      },
      appAccounts: [sandboxAccount.addr]
    });
    await claimVestingDuringStake.execute(algodClient,5);
    asset_info_result = await algodClient.accountAssetInformation(users[1].addr, testAsset).do();
    const assetBalance_post = asset_info_result["asset-holding"]["amount"];
    expect(assetBalance_post > assetBalance_pre).toEqual(true);
  });
});
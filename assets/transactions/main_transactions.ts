import path from "path";
import {
  Account,
  Algodv2,
  AtomicTransactionComposer,
  makeBasicAccountTransactionSigner,
  makeApplicationOptInTxnFromObject,
  makeApplicationCreateTxnFromObject,
  OnApplicationComplete,
  SuggestedParams,
  makeApplicationUpdateTxnFromObject,
  BoxReference,
  makeApplicationClearStateTxnFromObject,
  makePaymentTxnWithSuggestedParamsFromObject,
  getApplicationAddress,
} from "algosdk";
import {
  algodClient,
  getMethodByName,
  loadABIContract,
  compilePyTeal,
  sendTxn
} from "algoutils";

import {
  getABIHash
} from "../../utils/gora_utils";

const ABI_PATH = "../../assets/abi/main-contract.json";
const mainContractABI = loadABIContract(path.join(__dirname, ABI_PATH));

type DeployParams = {
  platformTokenAssetId: number,
  deployer: Account,
  voteApprovalProgram: Uint8Array,
  voteClearProgram: Uint8Array,
  minimumStake: number
}


export async function deployMainContract(deployParams: DeployParams){
  const abiHash = getABIHash("../assets/abi/main-contract.json");
  const base64VoteApprovalProgram = Buffer.from(deployParams.voteApprovalProgram).toString("base64");
  const base64VoteClearProgram = Buffer.from(deployParams.voteClearProgram).toString("base64");
  const mainContractParams = {
    TOKEN_ASSET_ID: deployParams.platformTokenAssetId,
    CONTRACT_VERSION: abiHash,
    VOTE_APPROVAL_PROGRAM: base64VoteApprovalProgram,
    VOTE_CLEAR_PROGRAM: base64VoteClearProgram,
    MINIMUM_STAKE: deployParams.minimumStake
  };

  const stakingApprovalCode = await compilePyTeal(path.join(__dirname, "../../assets/main_approval.py"), mainContractParams);
  const stakingClearCode = await compilePyTeal(path.join(__dirname, "../../assets/main_clear.py"));

  const storageSchema = {
    numGlobalByteSlices: 3,
    numGlobalInts: 13,
    numLocalByteSlices: 4,
    numLocalInts: 7
  };
  const transactionParams = await algodClient().getTransactionParams().do();
  const createApplicationTransaction = makeApplicationCreateTxnFromObject({
    suggestedParams: transactionParams,
    from: deployParams.deployer.addr,
    onComplete: OnApplicationComplete.NoOpOC,
    approvalProgram: stakingApprovalCode,
    clearProgram: stakingClearCode,
    extraPages: 3,
    ...storageSchema
  });

  const signedCreateTxn = createApplicationTransaction.signTxn(deployParams.deployer.sk);

  const txnResponse = await sendTxn(algodClient(), signedCreateTxn);

  const appId = txnResponse["application-index"];

  return appId;
}

type UpdateParams = {
  appIdToUpdate: number,
  platformTokenAssetId: number,
  deployer: Account,
  voteApprovalProgram: Uint8Array,
  voteClearProgram: Uint8Array,
  minimumStake: number,
}


export async function updateMainContract(deployParams: UpdateParams){
  const abiHash = getABIHash("../assets/abi/main-contract.json");
  const base64VoteApprovalProgram = Buffer.from(deployParams.voteApprovalProgram).toString("base64");
  const base64VoteClearProgram = Buffer.from(deployParams.voteClearProgram).toString("base64");
  const mainContractParams = {
    TOKEN_ASSET_ID: deployParams.platformTokenAssetId,
    CONTRACT_VERSION: abiHash,
    VOTE_APPROVAL_PROGRAM: base64VoteApprovalProgram,
    VOTE_CLEAR_PROGRAM: base64VoteClearProgram,
    MINIMUM_STAKE: deployParams.minimumStake
  };

  const stakingApprovalCode = await compilePyTeal(path.join(__dirname, "../../assets/main_approval.py"), mainContractParams);
  const stakingClearCode = await compilePyTeal(path.join(__dirname, "../../assets/main_clear.py"));

  const storageSchema = {
    numGlobalByteSlices: 2,
    numGlobalInts: 11,
    numLocalByteSlices: 3,
    numLocalInts: 7
  };
  const transactionParams = await algodClient().getTransactionParams().do();
  const updateApplicationTransaction = makeApplicationUpdateTxnFromObject({
    suggestedParams: transactionParams,
    appIndex: deployParams.appIdToUpdate,
    from: deployParams.deployer.addr,
    approvalProgram: stakingApprovalCode,
    clearProgram: stakingClearCode,
    ...storageSchema
  });

  const signedUpdateTxn = updateApplicationTransaction.signTxn(deployParams.deployer.sk);

  const txnResponse = await sendTxn(algodClient(), signedUpdateTxn);
  return txnResponse;
}

type InitParams = {
  platformTokenAssetId: number,
  user: Account, 
  appId: number, 
  suggestedParams: SuggestedParams,
  manager: string
}
                   
export function init(initParams: InitParams){
  const initGroup = new AtomicTransactionComposer();
  const suggestedParams = {
    ...initParams.suggestedParams,
    flatFee: true,
    fee: 2000
  };
  initGroup.addMethodCall({
    method: getMethodByName("init", mainContractABI),
    methodArgs: [
      initParams.platformTokenAssetId,
      initParams.manager
    ],
    sender: initParams.user.addr,
    signer: makeBasicAccountTransactionSigner(initParams.user),
    appID: initParams.appId,
    suggestedParams: suggestedParams,
  });
  return initGroup;
}

type UpdateProtocolParams = {
  user: Account, 
  appId: number, 
  suggestedParams: SuggestedParams,
  manager: string,
  refund_request_made_percentage: number,
  refund_processing_percentage: number,
  algo_request_fee: number,
  gora_request_fee: number,
  voting_threshold: number,
  time_lock: number,
  vote_refill_threshold: number,
  vote_refill_amount: number
}
                   
export function update_protocol_settings(params: UpdateProtocolParams){
  const updateProtocolGroup = new AtomicTransactionComposer();
  updateProtocolGroup.addMethodCall({
    method: getMethodByName("update_protocol_settings", mainContractABI),
    methodArgs: [
      params.manager,
      params.refund_request_made_percentage,
      params.refund_processing_percentage,
      params.algo_request_fee,
      params.gora_request_fee,
      params.voting_threshold,
      params.time_lock,
      params.vote_refill_threshold,
      params.vote_refill_amount,
    ],
    sender: params.user.addr,
    signer: makeBasicAccountTransactionSigner(params.user),
    appID: params.appId,
    suggestedParams: params.suggestedParams,
  });
  return updateProtocolGroup;
}

type UserOptInParams = {
  user: Account, 
  appId: number, 
  suggestedParams: SuggestedParams
}

export function userOptIn(userOptInParams: UserOptInParams){
  const optInGroup = new AtomicTransactionComposer();
  const optInTxn = makeApplicationOptInTxnFromObject({
    from: userOptInParams.user.addr,
    suggestedParams: userOptInParams.suggestedParams,
    appIndex: userOptInParams.appId
  });
  optInGroup.addTransaction({
    txn: optInTxn,
    signer: makeBasicAccountTransactionSigner(userOptInParams.user)
  });
  return optInGroup;
}

type UserOptOutParams = {
  user: Account, 
  appId: number, 
  suggestedParams: SuggestedParams
}

export function userOptOut(params: UserOptOutParams){
  const optOutGroup = new AtomicTransactionComposer();
  const optOutTxn = makeApplicationClearStateTxnFromObject({
    from: params.user.addr,
    suggestedParams: params.suggestedParams,
    appIndex: params.appId
  });
  optOutGroup.addTransaction({
    txn: optOutTxn,
    signer: makeBasicAccountTransactionSigner(params.user)
  });
  return optOutGroup;
}

type deployVoteContractParams = {
  staker:Account,
  appID:number,
  suggestedParamsFlatFee:SuggestedParams,
  suggestedParams:SuggestedParams
}

export function deployVoteContract(deployVoteContractParams:deployVoteContractParams){
  const deployContractGroup = new AtomicTransactionComposer();
  const transferTxn = {
    txn: makePaymentTxnWithSuggestedParamsFromObject({
      from: deployVoteContractParams.staker.addr,
      suggestedParams: deployVoteContractParams.suggestedParams,
      amount: 2_755_000,
      to: getApplicationAddress(deployVoteContractParams.appID),
    }),
    signer: makeBasicAccountTransactionSigner(deployVoteContractParams.staker)
  };

  deployContractGroup.addMethodCall({
    method: getMethodByName("deploy_voting_contract", mainContractABI),
    methodArgs: [
      transferTxn
    ],
    sender: deployVoteContractParams.staker.addr,
    signer: makeBasicAccountTransactionSigner(deployVoteContractParams.staker),
    appID: deployVoteContractParams.appID,
    suggestedParams: deployVoteContractParams.suggestedParamsFlatFee
  });

  return deployContractGroup;
}

type requestRefundParams = {
  algodClient: Algodv2,
  requesterAccount: Account,
  mainAppId: number,
  requestKeyHash: Uint8Array
}

export async function requestRefund({
  algodClient,
  requesterAccount,
  mainAppId,
  requestKeyHash
}: requestRefundParams)
{
  const suggestedParams = await algodClient.getTransactionParams().do();
  const requestRefundGroup = new AtomicTransactionComposer();
  const boxes: BoxReference[] = [
    {
      name: requestKeyHash,
      appIndex: mainAppId
    }
  ];
  requestRefundGroup.addMethodCall({
    method: getMethodByName("refund_request", mainContractABI),
    methodArgs: [
      requesterAccount.addr,
      requestKeyHash
    ],
    boxes: boxes,
    appID: mainAppId,
    suggestedParams: suggestedParams,
    sender: requesterAccount.addr,
    signer: makeBasicAccountTransactionSigner(requesterAccount)
  });

  return await requestRefundGroup.execute(algodClient, 5);
}
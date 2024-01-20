import * as fs from "fs";
import * as bkr from "beaker-ts";
import {
  decodeUint64,
  Algodv2,
  Account,
  getApplicationAddress,
  makePaymentTxnWithSuggestedParamsFromObject,
  ABIArrayDynamicType,
  ABIByteType
} from "algosdk";
import { compileBeaker, sendGenericPayment } from "../../utils/beaker_test_utils";
import { fundAccount } from "algotest";
import { VotingTestState } from "../../test/e2e/vote/voting.helpers";
import { sendASA } from "algoutils";
import { getLocalStateMain } from "../../utils/gora_utils";
import { SandboxAccount } from "beaker-ts/src/sandbox/accounts";
import { RequestParams } from "./abi_structures";
import { PricePair } from "./artifacts/pricepair_client";

export const getAppBoxes = async (app_id: number, algodClient? : Algodv2) =>
{
  const output: any = {};
  algodClient = (algodClient === undefined ? bkr.clients.sandboxAlgod() : algodClient);
  const boxesResponse = await algodClient.getApplicationBoxes(app_id).do();
  const boxNames = boxesResponse.boxes.map(box => box.name);

  const aggregation_boxes: any = [];
  for(let i = 0; i < boxNames.length; i++)
  {   
    const name = boxNames[i];
    const box = await algodClient.getApplicationBoxByName(app_id, name).do();
    const boxName = new TextDecoder("utf-8").decode(box.name);
    const boxValue = box.value;
  }
  //aggregation_boxes.sort((a : any, b : any) => (a.box_round > b.box_round) ? 1 : -1);
  return output;
};

export async function getMockMainLocal( app_id: number, address: string, algodClient? : Algodv2) {
  const output: any = {};
  const output_step: any = {};
  algodClient = (algodClient === undefined ? bkr.clients.sandboxAlgod() : algodClient);
  const app_info = await algodClient.accountApplicationInformation(address, app_id).do();
  const state = app_info["app-local-state"]["key-value"];
  for(let i = 0; i < state.length; i++)
  {
    output_step[Buffer.from(state[i].key, "base64").toString()] = state[i].value;
  }
  const account_algo = output_step["aa"].uint;
  const account_gora = output_step["at"].uint;
  output["rewards"] = {algo_rewards: Number(account_algo), gora_rewards: Number(account_gora)};
  return output;
}

export async function participation_optin(delegator_addr: string, testState: VotingTestState, participationAccount: Account) {
  await fundAccount(delegator_addr, 1_500_000);
  await sendASA({
    from: testState.mainAccount,
    to: delegator_addr,
    assetId: testState.platformTokenAssetId,
    amount: 20_000
  });
  // create a new map to avoid mutating the original
  const ephemeral_map_new = new Map(testState.ephemeral_map);
  ephemeral_map_new.set(delegator_addr, participationAccount);
  await fundAccount(participationAccount.addr, 1_500_000);
  await fundAccount(delegator_addr, 1_500_000);

  return ephemeral_map_new;
}

export function generateRequestParamsABI(
  pricePairName: string,
  tokenAssetId: number,
  sourceArr: [number, string[], number],
  aggMethod: number,
  userData: string,
  requestKey: string
) {

  const keyPrefixBytes = new Uint8Array(Buffer.from("req"))
  const pricePairNameBytes = new Uint8Array(Buffer.from(pricePairName))
  const requestPairName = new Uint8Array(keyPrefixBytes.length + pricePairNameBytes.length)
  requestPairName.set(keyPrefixBytes)
  requestPairName.set(pricePairNameBytes,keyPrefixBytes.length)

  const sourceId = BigInt(sourceArr[0])
  const maxAge = BigInt(sourceArr[2])
  const sourceArgsArr:Buffer[] = []
  for (let i = 0; i < sourceArr[1].length; i++){
    const sourceArg = Buffer.from(sourceArr[1][i]);
    sourceArgsArr.push(sourceArg)
  }


  const userDataABI = (new ABIArrayDynamicType(new ABIByteType)).encode(Buffer.from(userData));

  // To ensure you're encoding correctly and get the price of the box
  const RequestParamsABI = RequestParams.encode([
    Buffer.from(pricePairName),
    BigInt(tokenAssetId),
    [[sourceId,sourceArgsArr,maxAge]],
    BigInt(aggMethod),
    Buffer.from(userData)
  ])
  const requestParamsBoxCost = (RequestParamsABI.length + 2 + requestPairName.length) * 400 + 2500;

  return {
    requestParamsBoxName: requestPairName,
    pricePairName: new Uint8Array(Buffer.from(pricePairName)),
    tokenAssetId: BigInt(tokenAssetId),
    sourceArr: [[sourceId,sourceArgsArr,maxAge]] as [bigint, Uint8Array[], bigint][],
    aggMethod: BigInt(aggMethod),
    userData: userDataABI,
    requestParamsBoxCost: requestParamsBoxCost,
    requestKey: (new ABIArrayDynamicType(new ABIByteType)).encode(Buffer.from(requestKey))
  }
}

export async function createRequestParamsBox(
  pricePairBoxName:string,
  testAsset: number,
  pricePairClient: PricePair,
  managerAddress: string,
  appAddress: string,
  appId: number,
  requestKey: string
){
  const requestParams = generateRequestParamsABI(
    pricePairBoxName,
    testAsset,
    [7, [ "##signKey", "btc", "usd"  ], 60],
    0,
    pricePairBoxName,
    requestKey
  )

  const requestParamsBoxTxn = await pricePairClient.compose.create_request_params_box(
    {
      price_pair_name: requestParams.pricePairName,
      token_asset_id: requestParams.tokenAssetId,
      source_arr: requestParams.sourceArr,
      agg_method: requestParams.aggMethod,
      user_data: requestParams.userData,
      algo_xfer: makePaymentTxnWithSuggestedParamsFromObject({
        from: managerAddress,
        suggestedParams: await pricePairClient.client.getTransactionParams().do(),
        amount: requestParams.requestParamsBoxCost,
        to: appAddress,
      }),
    },
    {
      boxes:[
        {
          appIndex: appId,
          name: requestParams.requestParamsBoxName
        }
      ]
    }
  )
  const result = await requestParamsBoxTxn.execute(pricePairClient.client,5)
  return requestParams
}

// The below functions are from node runner code

// Unpack a number from smart contract compatible byte array and return as string.
// Parameters: "buff" - data to unpack (Buffer).
export function unpackNumber(buff:Buffer) {

  if (!buff[0])
    return NaN;

  const isNegative = buff[0] == 2;
  const intVal = buff.readBigUInt64BE(1) * BigInt(isNegative ? -1 : 1);
  const decVal = buff.readBigUInt64BE(9);
  return `${intVal}` + (decVal ? `.${decVal}` : "");
}

// Pack a number as smart contract compatible byte array and return as Buffer.
// Parameters: "numInput" - input number.
export function packNumber(numInput:number) {

  const res = Buffer.alloc(17);
  let intVal, decVal;

  try {
    const parts = Intl.NumberFormat("en", {
      notation: "standard",
      minimumSignificantDigits: 1,
      maximumSignificantDigits: 20,
      minimumFractionDigits: 0,
      maximumFractionDigits: 20,
      useGrouping: false
    }).formatToParts(numInput);

    intVal = BigInt(parts.find(x => x.type == "integer")!.value);
    decVal = BigInt(parts.find(x => x.type == "fraction")?.value || 0);
    res[0] = parts.some(x => x.type == "minusSign") ? 2 : 1;

    // const checkSize = (v,m) => {
    //   if (v > Goracle.maxUint64)
    //     throw new Goracle.AppError(`Cannot pack number "${num}", ${m} part too large: ${v}`);
    // };
    // checkSize(intVal, "integer");
    // checkSize(decVal, "decimal");

    res.writeBigUInt64BE(intVal, 1);
    res.writeBigUInt64BE(decVal, 9);
  }
  catch (err) {
    console.error(`Could not pack as number: "${numInput}"`);
    res[0] = 0; // NaN
  }

  return res;
}
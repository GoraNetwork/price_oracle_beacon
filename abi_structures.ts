import {
  ABIArrayDynamicType,
  ABIByteType,
  ABITupleType, 
  ABIUintType,
} from "algosdk";
import { SourceSpecType } from "../../utils/abi_types";

export const PricePairResponse = new ABITupleType([
  new ABIArrayDynamicType(new ABIByteType), // name
  new ABIUintType(64), // price
  new ABIUintType(64), // time_stamp
]);

export const RequestParams = new ABITupleType([
  new ABIArrayDynamicType(new ABIByteType), // price_pair_name
  new ABIUintType(64), // token_asset_id
  new ABIArrayDynamicType(SourceSpecType), // source_arr
  new ABIUintType(32), // agg_method
  new ABIArrayDynamicType(new ABIByteType), // user_data
]);
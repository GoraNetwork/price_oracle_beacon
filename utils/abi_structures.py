from pyteal import *
from typing import Literal as L

REQUEST_METHOD_SPEC = "(byte[],byte[],uint64,byte[],uint64[],uint64[],address[],(byte[],uint64)[])void"

class BoxType(abi.NamedTuple):
    key: abi.Field[abi.DynamicBytes]
    app_id: abi.Field[abi.Uint64]
    
class SourceSpec(abi.NamedTuple):
    source_id: abi.Field[abi.Uint32]
    source_arg_list: abi.Field[abi.DynamicArray[abi.DynamicBytes]]
    max_age: abi.Field[abi.Uint32]

class RequestSpec(abi.NamedTuple):
    source_specs: abi.Field[abi.DynamicArray[SourceSpec]]
    aggregation: abi.Field[abi.Uint32]
    user_data: abi.Field[abi.DynamicBytes]

class DestinationSpec(abi.NamedTuple):
    app_id: abi.Field[abi.Uint64]
    method: abi.Field[abi.DynamicBytes]

class ResponseBody(abi.NamedTuple):
    request_id: abi.Field[abi.StaticBytes[L[32]]]
    requester_addr: abi.Field[abi.Address]
    oracle_value: abi.Field[abi.DynamicBytes]
    user_data: abi.Field[abi.DynamicBytes]
    error_code: abi.Field[abi.Uint32]
    source_errors: abi.Field[abi.Uint64]


class RequestParams(abi.NamedTuple):
    price_pair_name: abi.Field[abi.DynamicBytes]
    token_asset_id: abi.Field[abi.Uint64]
    source_arr: abi.Field[abi.DynamicArray[SourceSpec]]
    agg_method: abi.Field[abi.Uint32]
    user_data: abi.Field[abi.DynamicBytes]
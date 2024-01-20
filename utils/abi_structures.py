import os
import pathlib
import sys
from pyteal import *
from algosdk import abi as sdk_abi

# sys.path.remove('/home/samfisher/Goracle/contracts/assets/price_pair')
sys.path.append(os.path.join(pathlib.Path(__file__).parent.resolve().parent.resolve().parent.resolve()))
from utils.abi_types import *

class BoxType(abi.NamedTuple):
    key: abi.Field[abi.DynamicBytes]
    app_id: abi.Field[abi.Uint64]

class PricePairResponse(abi.NamedTuple):
    name: abi.Field[abi.DynamicBytes]
    price: abi.Field[abi.Uint64]
    timestamp: abi.Field[abi.Uint64]

class RequestParams(abi.NamedTuple):
    price_pair_name: abi.Field[abi.DynamicBytes]
    token_asset_id: abi.Field[abi.Uint64]
    source_arr: abi.Field[abi.DynamicArray[SourceSpec]]
    agg_method: abi.Field[abi.Uint32]
    user_data: abi.Field[abi.DynamicBytes]


class OracleResponse(abi.NamedTuple):
    response: abi.Field[abi.DynamicBytes]


response_body_type = sdk_abi.TupleType([
    sdk_abi.ABIType.from_string("byte[32]"), # request_id
    sdk_abi.ABIType.from_string("address"), # requester_address
    sdk_abi.ABIType.from_string("byte[]"), # oracle return value
    sdk_abi.ABIType.from_string("byte[]"), # user data
    sdk_abi.ABIType.from_string("uint32"), # error code
    sdk_abi.ABIType.from_string("uint64") # source failure bitmap
])

response_body_bytes_type = sdk_abi.ArrayDynamicType(sdk_abi.ByteType())

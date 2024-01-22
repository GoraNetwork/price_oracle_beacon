from pyteal import *
import beaker as BK
from beaker.decorators import Authorize
from beaker.lib.storage import BoxMapping
from utils.subroutines import verify_algo_xfer,send_algo
from assets.helpers.key_map import key_map as protocol_key_map
from utils.consts import GORA_CONTRACT_ID,GORA_CONTRACT_ADDRESS_BIN
from utils.gora_pyteal_utils import (opt_in as gora_opt_in,opt_in_asset)
from utils.abi_structures import (RequestParams,ResponseBody,SourceSpec,
                                  RequestSpec,DestinationSpec,BoxType,
                                  REQUEST_METHOD_SPEC)


MLKEYMAP = protocol_key_map['main_local']
VGKEYMAP = protocol_key_map['voting_global']
RSKEYMAP = protocol_key_map['request_status']


DEMO_MODE = False
KEY_PREFIX = Bytes("req")
GORA_CONTRACT_ID = Int(GORA_CONTRACT_ID)
GORA_CONTRACT_ADDRESS  = Bytes(GORA_CONTRACT_ADDRESS_BIN)


class MyState:
    manager = BK.GlobalStateValue(TealType.bytes)
    oracle_request_params = BoxMapping(abi.DynamicBytes, RequestParams)
    oracle_response = BoxMapping(abi.DynamicBytes, abi.DynamicBytes)  # This is a key value pair of the oracle response


    

PricePair = BK.Application(
    "PricePair", state=MyState(), build_options=BK.BuildOptions(avm_version=8)
)


def verify_app_call():
    # assert that this is coming from a voting contract
    voting_contract_creator = App.globalGetEx(Global.caller_app_id(),VGKEYMAP["creator"])
    vote_app_creator = AppParam.creator(Global.caller_app_id())

    if DEMO_MODE:
        return Assert(Int(1) == Int(1))
    else:
        return Seq(
            vote_app_creator,
            voting_contract_creator,
            Assert(
                Txn.sender() != PricePair.state.manager.get(),
                vote_app_creator.value() == GORA_CONTRACT_ADDRESS ,
                vote_app_creator.value() == voting_contract_creator.value(),
                Txn.application_id() == Global.current_application_id(),
            )
        )

@PricePair.create(bare=True)
def create():
    return Seq(
        PricePair.initialize_global_state(),
        PricePair.state.manager.set(Global.creator_address())
    )

@PricePair.opt_in()
def opt_in():
    return Seq(
        Reject()
    )

@PricePair.update(authorize=Authorize.only(PricePair.state.manager.get()))
def update():
    return Seq(
        Approve()
    )

@PricePair.external(authorize=Authorize.only(PricePair.state.manager.get()))
def delete():
    return Seq(
        # TODO: how decentralized do we want this initial one? Do want to be able to Delete/Update?
        Approve()
    )

@PricePair.external(authorize=Authorize.only(PricePair.state.manager.get()))
def update_manager(
    new_manager: abi.Address
):
    return Seq(
        Assert(
            new_manager.get() != Global.zero_address(),
            Len(new_manager.get()) == Int(32)
        ),
        PricePair.state.manager.set(new_manager.get())
    )


@PricePair.external(authorize=Authorize.only(PricePair.state.manager.get()))
def create_request_params_box(
    price_pair_name: abi.DynamicBytes,
    token_asset_id: abi.Uint64,
    source_arr: abi.DynamicArray[SourceSpec],
    agg_method: abi.Uint32,
    user_data: abi.DynamicBytes,
    algo_xfer: abi.PaymentTransaction
): 
    # The key for this box is a combination of Bytes("req") plus the price pair name
    return Seq(
        (box_key_bytes := abi.DynamicBytes()).set(Concat(KEY_PREFIX,price_pair_name.get())),
        (request_params_abi := abi.make(RequestParams)).set(
            price_pair_name,
            token_asset_id,
            source_arr,
            agg_method,
            user_data
        ),
        Pop(PricePair.state.oracle_request_params[box_key_bytes.get()].delete()),
        (contract_min_bal_cost := abi.Uint64()).set(MinBalance(Global.current_application_address())),
        contract_min_bal_cost.set(MinBalance(Global.current_application_address()) - contract_min_bal_cost.get()),
        PricePair.state.oracle_request_params[box_key_bytes.get()].set(request_params_abi),
        verify_algo_xfer(contract_min_bal_cost,algo_xfer)
    )

@PricePair.external(authorize=Authorize.only(PricePair.state.manager.get()))
def delete_request_params_box(
    price_pair_name: abi.DynamicBytes
):
    return Seq(
        (box_key_bytes := abi.DynamicBytes()).set(Concat(KEY_PREFIX,price_pair_name.get())),
        (contract_min_bal_cost := abi.Uint64()).set(MinBalance(Global.current_application_address())),
        Pop(PricePair.state.oracle_request_params[box_key_bytes.get()].delete()),
        contract_min_bal_cost.set(contract_min_bal_cost.get() - MinBalance(Global.current_application_address())),
        send_algo(
            PricePair.state.manager.get(),
            contract_min_bal_cost.get(),
            # Int(10_000)
        ),
    )


@PricePair.external(authorize=Authorize.only(PricePair.state.manager.get()))
def opt_in_gora(
    asset_reference: abi.Asset,
    main_app_reference: abi.Application,
):
    return Seq(
        Assert(Txn.sender() == Global.creator_address()),
        opt_in_asset(Txn.assets[0]),
        gora_opt_in(Txn.applications[1])
    )

# TODO: ensure that only the vote contract can make the update to the prices (NOT even manager)
@PricePair.external()
def update_price(
    response_type_bytes: abi.Uint32,
    response_body_bytes: abi.DynamicBytes,
):
    return Seq(
        verify_app_call(),
        (response_body := abi.make(ResponseBody)).decode(response_body_bytes.get()),
        response_body.oracle_value.store_into(
            oracle_return_value := abi.make(abi.DynamicBytes)
        ),
        response_body.user_data.store_into(
            price_pair_name := abi.make(abi.DynamicBytes)
        ),
        PricePair.state.oracle_response[price_pair_name.get()].set(oracle_return_value.get())
    )

@PricePair.external()
def send_request(
    price_pair_name: abi.DynamicBytes,
    key: abi.DynamicBytes
):
    return Seq(
        (box_key_bytes := abi.DynamicBytes()).set(Concat(KEY_PREFIX,price_pair_name.get())),
        # request_args
        (request_params := abi.make(RequestParams)).decode(PricePair.state.oracle_request_params[box_key_bytes.get()].get()),


        Assert(GORA_CONTRACT_ID == Txn.applications[1]),
        (source_arr := abi.make(abi.DynamicArray[SourceSpec])).set(request_params.source_arr),
        (agg_method := abi.Uint32()).set(request_params.agg_method),
        (user_data := abi.make(abi.DynamicBytes)).set(request_params.user_data),
        (request_tuple := abi.make(RequestSpec)).set(
            source_arr,
            agg_method,
            user_data
        ),
        (request_spec_packed := abi.DynamicBytes()).set(request_tuple.encode()),

        # destination
        (app_id_param := abi.Uint64()).set(Global.current_application_id()),
        (method_sig_param := abi.DynamicBytes()).set(Bytes("update_price")),
        (destination_tuple := abi.make(DestinationSpec)).set(
            app_id_param,
            method_sig_param
        ),
        (dest_packed := abi.DynamicBytes()).set(destination_tuple.encode()),

        # type
        (request_type_param := abi.Uint64()).set(Int(1)),

        # key
        # simple enough that it's simply in the method args below

        # app_refs
        (current_app_id := abi.make(abi.Uint64)).set(Global.current_application_id()),
        (app_refs := abi.make(abi.DynamicArray[abi.Uint64])).set([]),
        
        # asset_refs
        (asset_refs := abi.make(abi.DynamicArray[abi.Uint64])).set([]),

        # account_refs
        (account_refs := abi.make(abi.DynamicArray[abi.Address])).set([]),

        # box_refs
        (price_box := abi.make(BoxType)).set(price_pair_name,current_app_id),
        (box_refs := abi.make(abi.DynamicArray[BoxType])).set([price_box]),
        InnerTxnBuilder.Begin(),
        InnerTxnBuilder.MethodCall(
            app_id= GORA_CONTRACT_ID,
            method_signature="request" + REQUEST_METHOD_SPEC,
            args=[
                request_spec_packed,
                dest_packed,
                request_type_param,
                key,
                app_refs,
                asset_refs,
                account_refs,
                box_refs
            ]
        ),
        InnerTxnBuilder.Submit(),
    )
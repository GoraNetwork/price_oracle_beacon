import beaker
from beaker.decorators import Authorize
# from beaker.application import initialize_global_state
import sys
from pathlib import Path
import yaml
from pyteal import *
import algosdk
from typing import Literal as L
from dotenv import load_dotenv
load_dotenv()

sys.path.append(".")
from abi_structures import *
from assets.helpers.key_map import key_map as protocol_key_map
from utils.gora_pyteal_utils import (
    opt_in as gora_opt_in, 
    get_method_signature, 
    opt_in_asset
)
from utils.abi_types import *

MLKEYMAP = protocol_key_map['main_local']
VGKEYMAP = protocol_key_map['voting_global']
RSKEYMAP = protocol_key_map['request_status']

MAIN_APP_ID = Int(0)
MAIN_APP_ADDRESS = Bytes("")
DEMO_MODE = False
KEY_PREFIX = Bytes("req")

class MyState:
    manager = beaker.GlobalStateValue(TealType.bytes)

app = beaker.Application("PricePair",state=MyState(),build_options=beaker.BuildOptions(avm_version=8))
gora_num_response = abi.StaticBytes[L[17]]

def send_algo(receiver, amount, fee_amount):
    return Seq([
        InnerTxnBuilder.Begin(),
        InnerTxnBuilder.SetFields({
            TxnField.type_enum: TxnType.Payment,
            TxnField.receiver: receiver,
            TxnField.amount: amount,
            TxnField.fee: fee_amount
        }),
        InnerTxnBuilder.Submit()
    ])

def verify_algo_xfer(amount:abi.Uint64,algo_xfer:abi.PaymentTransaction):
    return Assert(
        algo_xfer.get().amount() == amount.get(),
        algo_xfer.get().type_enum() == TxnType.Payment,
        algo_xfer.get().receiver() == Global.current_application_address(),
        algo_xfer.get().close_remainder_to() == Global.zero_address(),
        algo_xfer.get().rekey_to() == Global.zero_address(),
        algo_xfer.get().lease() == Global.zero_address()
    )
# TODO: do I need to make a withdraw gora function?

@app.create(bare=True)
def create():
    return Seq(
        app.initialize_global_state(),
        app.state.manager.set(Global.creator_address())
    )

@app.external(authorize=Authorize.only(app.state.manager.get()))
def update_manager(
    new_manager: abi.Address
):
    return Seq(
        Assert(
            new_manager.get() != Global.zero_address(),
            Len(new_manager.get()) == Int(32)
        ),
        app.state.manager.set(new_manager.get())
    )

@app.opt_in()
def opt_in():
    return Seq(
        Reject()
    )

@app.update(authorize=Authorize.only(app.state.manager.get()))
def update():
    return Seq(
        Approve()
    )

@app.external(authorize=Authorize.only(app.state.manager.get()))
def delete():
    return Seq(
        # TODO: how decentralized do we want this initial one? Do want to be able to Delete/Update?
        Approve()
    )

@app.external(authorize=Authorize.only(app.state.manager.get()))
def create_price_box(
    price_pair_name: abi.DynamicBytes,
    algo_xfer: abi.PaymentTransaction
):
    # This can only create new boxes and not overwrite current ones
    return Seq(
        (contract_min_bal_cost := abi.Uint64()).set(MinBalance(Global.current_application_address())),
        Assert(App.box_create(price_pair_name.get(),Int(17))),
        contract_min_bal_cost.set(MinBalance(Global.current_application_address()) - contract_min_bal_cost.get()),
        verify_algo_xfer(contract_min_bal_cost,algo_xfer)
    )

@app.external(authorize=Authorize.only(app.state.manager.get()))
def delete_price_box(
    price_pair_name: abi.DynamicBytes,
):
    # This can only delete price pairs after a sufficient amount of time since the price has been updated
    return Seq(
        (contract_min_bal_cost := abi.Uint64()).set(MinBalance(Global.current_application_address())),
        box_bytes := App.box_get(price_pair_name.get()),
        Assert(box_bytes.hasValue()),
        Assert(App.box_delete(price_pair_name.get())),
        contract_min_bal_cost.set(contract_min_bal_cost.get() - MinBalance(Global.current_application_address())),
        send_algo(
            app.state.manager.get(),
            contract_min_bal_cost.get(),
            Int(0)
        )
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
                Txn.sender() != app.state.manager.get(),
                vote_app_creator.value() == MAIN_APP_ADDRESS,
                vote_app_creator.value() == voting_contract_creator.value(),
                Txn.application_id() == Global.current_application_id(),
            )
        )

@app.external(authorize=Authorize.only(app.state.manager.get()))
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
        Pop(App.box_delete(box_key_bytes.get())),
        Assert(price_pair_name.get() == Substring(user_data.get(),Int(2),Len(user_data.get()))),
        (contract_min_bal_cost := abi.Uint64()).set(MinBalance(Global.current_application_address())),
        Pop(App.box_create(box_key_bytes.get(),Len(request_params_abi.encode()))),
        contract_min_bal_cost.set(MinBalance(Global.current_application_address()) - contract_min_bal_cost.get()),
        App.box_put(box_key_bytes.get(),request_params_abi.encode()),
        verify_algo_xfer(contract_min_bal_cost,algo_xfer)
    )

@app.external(authorize=Authorize.only(app.state.manager.get()))
def delete_request_params_box(
    price_pair_name: abi.DynamicBytes
):
    return Seq(
        (box_key_bytes := abi.DynamicBytes()).set(Concat(KEY_PREFIX,price_pair_name.get())),
        (contract_min_bal_cost := abi.Uint64()).set(MinBalance(Global.current_application_address())),
        box_bytes := App.box_get(box_key_bytes.get()),
        Assert(box_bytes.hasValue()),
        Assert(App.box_delete(box_key_bytes.get())),
        contract_min_bal_cost.set(contract_min_bal_cost.get() - MinBalance(Global.current_application_address())),
        send_algo(
            app.state.manager.get(),
            contract_min_bal_cost.get(),
            Int(0)
        ),
    )

# TODO: ensure that only the vote contract can make the update to the prices (NOT even manager)
@app.external()
def update_price(
    response_type_bytes: abi.Uint32,
    response_body_bytes: abi.DynamicBytes,
):
    return Seq(
        verify_app_call(),
        (response_body := abi.make(ResponseBody)).decode(response_body_bytes.get()),
        response_body.oracle_return_value
        .store_into(oracle_return_value := abi.make(abi.DynamicArray[abi.Byte])),
        response_body.user_data.store_into(price_pair_name := abi.make(abi.DynamicArray[abi.Byte])),
        (price_pair_response := abi.make(gora_num_response)).decode(Substring(oracle_return_value.encode(),Int(2),Len(oracle_return_value.encode()))),
        price_box_bytes := App.box_get(Substring(price_pair_name.encode(),Int(4),Len(price_pair_name.encode()))),
        Assert(price_box_bytes.hasValue()),
        # Write price pair response to it's box
        App.box_put(Substring(price_pair_name.encode(),Int(4),Len(price_pair_name.encode())),price_pair_response.get()),
    )

@app.external()
def send_request(
    price_pair_name: abi.DynamicBytes,
    key: abi.DynamicBytes
):
    return Seq(
        (box_key_bytes := abi.DynamicBytes()).set(Concat(KEY_PREFIX,price_pair_name.get())),
        sequence_box_bytes := App.box_get(box_key_bytes.get()),
        Assert(sequence_box_bytes.hasValue()),
        # request_args
        (request_params := abi.make(RequestParams)).decode(sequence_box_bytes.value()),
        Assert(MAIN_APP_ID == Txn.applications[1]),
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
            app_id= MAIN_APP_ID,
            method_signature=get_method_signature("request","main"),
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

# TODO: not sure we need this
@app.external(authorize=Authorize.only(app.state.manager.get()))
def opt_in_gora(
    asset_reference: abi.Asset,
    main_app_reference: abi.Application,
):
    return Seq(
        Assert(Txn.sender() == Global.creator_address()),
        opt_in_asset(Txn.assets[0]),
        gora_opt_in(Txn.applications[1])
    )

if __name__ == "__main__":
    params = yaml.safe_load(sys.argv[1])
    MAIN_APP_ID = Int(params["MAIN_APP_ID"])
    MAIN_APP_ADDRESS = Bytes(algosdk.encoding.decode_address(algosdk.logic.get_application_address(params['MAIN_APP_ID'])))
    DEMO_MODE = params["DEMO_MODE"]
    output_dir = Path(__file__).parent / "artifacts"
    app_spec = app.build(beaker.sandbox.get_algod_client()).export(output_dir)

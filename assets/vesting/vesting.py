# pylint: disable=E0611, E1121, E1101
import sys
import yaml
sys.path.append('.')
from pyteal import *
from beaker import *
import algosdk
from beaker.lib.storage.mapping import Mapping
from typing import Literal as L
from assets.vesting.abi_structures import VestingEntry, VestingKey

MAIN_APP_ADDRESS = Bytes("")
class Vesting(Application):
    vesting_box = Mapping(VestingKey, VestingEntry)
    whitelisted_delegation_apps = Mapping(abi.Uint64, abi.StaticBytes[L[0]])

    def __init__(self, version: int = ...):
        super().__init__(version)

    # TODO: we need to update this to block claiming while staked for future vesting contracts

    @internal(TealType.none)
    def send_asset(self, asset_id, receiver, amount, fee_amount):
        return Seq([
            InnerTxnBuilder.Begin(),
            InnerTxnBuilder.SetFields({
                TxnField.type_enum: TxnType.AssetTransfer,
                TxnField.xfer_asset: asset_id,
                TxnField.asset_receiver: receiver,
                TxnField.asset_amount: amount,
                TxnField.fee: fee_amount
            }),
            InnerTxnBuilder.Submit()
        ])
    
    @internal(TealType.none)
    def send_algo(self, receiver, amount, fee_amount):
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

    @create
    def create(
        self
    ):
        return Seq([
            self.initialize_application_state(),
        ])

    @opt_in
    def opt_in(
        self,
    ):
        return Seq([
            Reject()
        ])
    
    @update
    def update(
        self
    ):
        return Seq([
            Reject()
        ])
    
    @delete
    def delete(
        self
    ):
        return Seq([
            Reject()
        ])
    
    @external()
    def optin_asset(
        self,
        algo_xfer: abi.PaymentTransaction,
        asset: abi.Asset,
        main_app_id: abi.Application,
        main_app_addr: abi.Address
    ):
        return Seq([
            Assert(main_app_addr.get() == MAIN_APP_ADDRESS),
            (main_app_gora_balance := AssetHolding.balance(MAIN_APP_ADDRESS,asset.asset_id())),
            Assert(main_app_gora_balance.hasValue() == Int(1)),
            (asset_id_int := abi.Uint64()).set(asset.asset_id()),
            (receiver := abi.Address()).set(Global.current_application_address()),
            (receiver_mbr := abi.Uint64()).set(MinBalance(receiver.get())),
            self.send_asset(asset_id_int.get(), receiver.get(), Int(0), Int(0)),
            (mbr_increase_cost := abi.Uint64()).set(MinBalance(receiver.get()) - receiver_mbr.get()),
            Assert(algo_xfer.get().amount() == mbr_increase_cost.get()),
            Assert(algo_xfer.get().receiver() == Global.current_application_address())
        ])

    @external()
    def vest_tokens(
        self,
        algo_xfer: abi.PaymentTransaction,
        token_xfer: abi.AssetTransferTransaction,
        vest_to : abi.Address,
        vesting_key: abi.DynamicBytes,
        time_to_vest: abi.Uint64,
    ):
        return Seq([
            (token_xfer_asset := abi.Uint64()).set(token_xfer.get().xfer_asset()),
            (vest_amount := abi.Uint64()).set(token_xfer.get().asset_amount()),
            (start_time := abi.Uint64()).set(Global.latest_timestamp()),
            (amount_claimed := abi.Uint64()).set(Int(0)),         

            time_to_vest.set(time_to_vest.get() + Global.latest_timestamp()),
            (key_hash := abi.StaticBytes(abi.StaticBytesTypeSpec(32))).set(Sha512_256(Concat(Itob(token_xfer_asset.get()), Txn.sender(), vesting_key.get()))),
            Assert(
                vest_to.get() != Global.zero_address(),
                Len(vest_to.get()) == Int(32)
            ),
            (key := VestingKey()).set(vest_to, key_hash),
            (vester := abi.Address()).set(Txn.sender()),
            (staked := abi.Bool()).set(False),
            (entry := VestingEntry()).set(start_time, time_to_vest, token_xfer_asset, vest_amount, amount_claimed, vester, staked),
            (contract_min_bal := abi.Uint64()).set(MinBalance(Global.current_application_address())),
            Assert(Not(self.vesting_box[key].exists())),
            self.vesting_box[key].set(entry),
            (box_cost := abi.Uint64()).set(MinBalance(Global.current_application_address()) - contract_min_bal.get()),
            Assert(
                algo_xfer.get().amount() == box_cost.get(),
                algo_xfer.get().type_enum() == TxnType.Payment,
                algo_xfer.get().receiver() == Global.current_application_address(),
                algo_xfer.get().close_remainder_to() == Global.zero_address(),
                algo_xfer.get().rekey_to() == Global.zero_address(),
                algo_xfer.get().lease() == Global.zero_address()
            ),
            Assert(
                token_xfer.get().type_enum() == TxnType.AssetTransfer,
                token_xfer.get().asset_receiver() == Global.current_application_address(),
                token_xfer.get().asset_sender() == Global.zero_address(),
                token_xfer.get().close_remainder_to() == Global.zero_address(),
                token_xfer.get().rekey_to() == Global.zero_address(),
                token_xfer.get().lease() == Global.zero_address(),
                token_xfer.get().asset_close_to() == Global.zero_address()
            )
        ])
    
    @external()
    def claim_vesting(
        self,
        vestee: abi.Address,
        key_hash: abi.StaticBytes[L[32]],
        asset_ref: abi.Asset,
        receiver_ref: abi.Account,
    ):
        return Seq([
            Assert(
                vestee.get() != Global.zero_address(),
                Len(vestee.get()) == Int(32)
            ),
            (box_key := VestingKey()).set(vestee, key_hash),

            (entry := VestingEntry()).decode(self.vesting_box[box_key].get()),

            (entry_start_time := abi.Uint64()).set(entry.start_time),
            (entry_unlock_time := abi.Uint64()).set(entry.unlock_time),
            (entry_amount_claimed := abi.Uint64()).set(entry.amount_claimed),

            (entry_asset := abi.Uint64()).set(entry.token_id),
            (entry_amount := abi.Uint64()).set(entry.amount),
            (entry_vester := abi.Address()).set(entry.vester),
            Assert(entry_vester.get() != Global.zero_address()),
            (amount_claimable := abi.Uint64()).set(Int(0)),

            # Either able to claim the full amount, or the amount that is claimable
            If(entry_unlock_time.get() > Global.latest_timestamp()).Then(
                    (total_time_span := abi.Uint64()).set(entry_unlock_time.get() - entry_start_time.get()),
                    (time_elapsed := abi.Uint64()).set(Global.latest_timestamp() - entry_start_time.get()),
                    amount_claimable.set(
                        # Higher precision by multiplying first, then dividing
                        # dy = (amount * time elapsed) / dx
                        # subtract the amount already claimed
                        WideRatio(
                            [entry_amount.get(),time_elapsed.get()],
                            [total_time_span.get()]
                        ) - entry_amount_claimed.get()
                    ),
            ).Else(
                    amount_claimable.set(entry_amount.get() - entry_amount_claimed.get()),
            ),

            self.send_asset(entry_asset.get(), vestee.get(), amount_claimable.get(), Int(0)),

            # Update the amount claimed or delete the entry
            If(entry_amount_claimed.get() + amount_claimable.get() == entry_amount.get()).Then(
                (contract_min_balance := abi.Uint64()).set(MinBalance(Global.current_application_address())),
                Pop(self.vesting_box[box_key].delete()),
                (box_cost := abi.Uint64()).set(contract_min_balance.get() - MinBalance(Global.current_application_address())),
                #refund the vestor for the box.
                self.send_algo(entry_vester.get(), box_cost.get() - Global.min_txn_fee(), Int(0))
            ).Else(
                entry_amount_claimed.set(entry_amount_claimed.get() + amount_claimable.get()),
                (entry_staked := abi.Bool()).set(entry.staked),
                # Create a new VestingEntry() with the updated amount_claimed
                (entry := VestingEntry()).set(entry_start_time, entry_unlock_time, entry_asset, entry_amount, entry_amount_claimed, entry_vester, entry_staked),
                self.vesting_box[box_key].set(entry),
            ),
        ])
    
    @external()
    def stake_to_delegator(
        self,
        delegator: abi.Application,
        key_hash: abi.StaticBytes[L[32]], #the vesting hash
        main_app_ref: abi.Application,
        asset_reference: abi.Asset,
        manager_reference: abi.Account,
    ):
        delegator_addr = AppParam.address(delegator.application_id())

        return Seq([
            delegator_addr,
            Assert(delegator_addr.hasValue()),
            (whitelist_key := abi.Uint64()).set(delegator.application_id()),
            Assert(self.whitelisted_delegation_apps[whitelist_key].exists()),

            (sender := abi.Address()).set(Txn.sender()),
            (box_key := VestingKey()).set(sender, key_hash),
            (entry := VestingEntry()).decode(self.vesting_box[box_key].get()),
            (entry_asset := abi.Uint64()).set(entry.token_id),
            (entry_amount := abi.Uint64()).set(entry.amount),
            (entry_unlock_time := abi.Uint64()).set(entry.unlock_time),
            (entry_vester := abi.Address()).set(entry.vester),
            Assert(entry_vester.get() != Global.zero_address()),
            (entry_staked := abi.Bool()).set(entry.staked),
            (start_time := abi.Uint64()).set(Global.latest_timestamp()),
            (amount_claimed := abi.Uint64()).set(Int(0)),         

            Assert(entry_staked.get() == Int(0)),
            InnerTxnBuilder.Begin(),
            InnerTxnBuilder.MethodCall(
                app_id=delegator.application_id(),
                method_signature="stake(axfer,account,application,asset,account)void",
                args=[
                    {
                        TxnField.type_enum: TxnType.AssetTransfer,
                        TxnField.asset_amount: entry_amount.get(),
                        TxnField.xfer_asset: entry_asset.get(),
                        TxnField.asset_receiver: delegator_addr.value()
                    },
                    Txn.sender(),
                    main_app_ref,
                    asset_reference,
                    manager_reference
                ],
                extra_fields={
                    TxnField.fee: Int(0)
                }
            ),
            InnerTxnBuilder.Submit(),

            entry_staked.set(True),
            (entry := VestingEntry()).set(start_time, entry_unlock_time, entry_asset, entry_amount, amount_claimed, entry_vester, entry_staked),
            self.vesting_box[box_key].set(entry)
        ])
    
    @external()
    def withdraw_from_delegator(
        self,
        delegator: abi.Application,
        key_hash: abi.StaticBytes[L[32]], #the vesting hash
        main_app_ref: abi.Application,
        asset_reference: abi.Asset,
        manager_reference: abi.Account,
    ):
        return Seq([
            (sender := abi.Address()).set(Txn.sender()),
            (box_key := VestingKey()).set(sender, key_hash),
            (entry := VestingEntry()).decode(self.vesting_box[box_key].get()),
            (entry_asset := abi.Uint64()).set(entry.token_id),
            (entry_amount := abi.Uint64()).set(entry.amount),
            (entry_unlock_time := abi.Uint64()).set(entry.unlock_time),
            (entry_vester := abi.Address()).set(entry.vester),
            Assert(entry_vester.get() != Global.zero_address()),
            (entry_staked := abi.Bool()).set(entry.staked),
            (entry_amount_claimed := abi.Uint64()).set(entry.amount_claimed),
            (entry_start_time := abi.Uint64()).set(entry.start_time),

            Assert(entry_staked.get() == Int(1)),
            InnerTxnBuilder.Begin(),
            InnerTxnBuilder.MethodCall(
                app_id=delegator.application_id(),
                method_signature="withdraw_non_stake(account,asset,application,account)void",
                args=[
                    Txn.sender(),
                    asset_reference,
                    main_app_ref,
                    manager_reference
                ],
                extra_fields={
                    TxnField.fee: Int(0)
                }
            ),
            InnerTxnBuilder.Submit(),

            entry_staked.set(False),
            (entry := VestingEntry()).set(entry_start_time, entry_unlock_time, entry_asset, entry_amount, entry_amount_claimed, entry_vester, entry_staked),
            self.vesting_box[box_key].set(entry)
        ])

    @external(authorize=Authorize.only(Global.creator_address()))
    def add_whitelisted_app(
        self,
        algo_xfer: abi.PaymentTransaction,
        app_id: abi.Application,
    ):
        return Seq([
            (contract_min_bal := abi.Uint64()).set(MinBalance(Global.current_application_address())),
            (app_id_abi := abi.Uint64()).set(app_id.application_id()),
            self.whitelisted_delegation_apps[app_id_abi].set(Bytes("")),
            (box_cost := abi.Uint64()).set(MinBalance(Global.current_application_address()) - contract_min_bal.get()),
            Assert(algo_xfer.get().receiver() == Global.current_application_address()),
            Assert(algo_xfer.get().amount() == box_cost.get()),
        ])
    
if __name__ == "__main__":
    params = yaml.safe_load(sys.argv[1])
    TEAL_VERSION = 8
    MAIN_APP_ADDRESS = Bytes(algosdk.encoding.decode_address(algosdk.logic.get_application_address(params['MAIN_APP_ID'])))
    Pragma(
        Vesting(version=TEAL_VERSION).dump("./assets/vesting/artifacts", client=sandbox.get_algod_client()),
        compiler_version="0.23.0"        
    )
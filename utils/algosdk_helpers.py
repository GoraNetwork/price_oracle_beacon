
import beaker as BK
import algokit_utils
import json,hashlib,struct
from algosdk.transaction import (
    AssetCreateTxn,
    AssetTransferTxn,
    PaymentTxn,
    wait_for_confirmation,
    ApplicationOptInTxn,
)

from algosdk.atomic_transaction_composer import (
    AtomicTransactionComposer,
    TransactionWithSigner,
    AccountTransactionSigner,
)

from algosdk.encoding import decode_address
from assets.abi import ABI_PATH,system_delima
from algosdk.logic import get_application_address
from algosdk.abi.method import get_method_by_name,Method



ALGOD_CLIENT =  BK.localnet.get_algod_client()
GORACLE_ABI = json.load(open(ABI_PATH + f"{system_delima}main-contract.json"))


def describe_gora_num(packed):
    """
        Return text description of a numeric oracle response.
    """

    if packed is None:
        return "None"
    if packed[0] == 0:
        return "NaN"

    int_part = struct.unpack_from('>Q', packed, 1)
    dec_part = struct.unpack_from('>Q', packed, 9)
    prefix = "-" if packed[0] == 2 else ""
    return prefix + str(int_part[0]) + "." + str(dec_part[0])


def get_gora_box_name(req_key, addr):
    """
        Return Algorand storage box name for a Gora request key and requester address.
    """
    pub_key = decode_address(addr)
    hash_src = pub_key + req_key
    name_hash = hashlib.new("sha512_256", hash_src)
    return name_hash.digest()


def get_methods_list(abi_json: dict):
    """ This gets the list of methods given the ABI """
    abi_methods = abi_json["methods"]

    methods_list = []
    for method in abi_methods:
        json_string = json.dumps(method)
        abi_method = Method.from_json(json_string)
        methods_list.append(abi_method)
    return methods_list


def fund_account(receiver_address, amount: int):
    """ This is acts as the algo dispenser """
    # get dispenser account
    dispenser_account = algokit_utils.get_dispenser_account(ALGOD_CLIENT)
    suggested_params = ALGOD_CLIENT.suggested_params()

    unsigned_txn = PaymentTxn(
        sender=dispenser_account.address,
        sp=suggested_params,
        receiver=receiver_address,
        amt=amount,
    )
    signed_txn = unsigned_txn.sign(dispenser_account.private_key)

    txid = ALGOD_CLIENT.send_transaction(signed_txn)
    txn_result = wait_for_confirmation(ALGOD_CLIENT, txid, 4)

    return json.dumps(txn_result, indent=4)


def stake_gora_for_requests(algod_client, account,deposit_amount,request_contract_address,gora_contract_id,gora_token_id):
    """
        Setup a token deposit with Gora for a given account and app.
        This serves as the vesting/ staking of gora for making requests
    """
    composer = AtomicTransactionComposer()
    unsigned_transfer_txn = AssetTransferTxn(
        sender=account.address,
        sp=algod_client.suggested_params(),
        receiver=get_application_address(gora_contract_id),
        index=gora_token_id,
        amt=deposit_amount,
    )
    signer = AccountTransactionSigner(account.private_key)
    signed_transfer_txn = TransactionWithSigner(
        unsigned_transfer_txn,
        signer
    )
    composer.add_method_call(
        app_id=gora_contract_id,
        method=get_method_by_name(
                get_methods_list(GORACLE_ABI), "deposit_token"
            ),
        sender=account.address,
        sp=algod_client.suggested_params(),
        signer=signer,
        method_args=[ signed_transfer_txn, gora_token_id, request_contract_address ]
    )
    composer.execute(algod_client, 4)




def stake_algo_for_requests(algod_client,account,deposit_amount,request_contract_address,gora_contract_id):
    """
        Setup an Algo deposit with Gora for a given account and app.
        This serves as the vesting/ staking of algo for making requests
    """

    composer = AtomicTransactionComposer()
    unsigned_payment_txn = PaymentTxn(
        sender=account.address,
        sp=algod_client.suggested_params(),
        receiver=get_application_address(gora_contract_id),
        amt=deposit_amount,
    )
    signer = AccountTransactionSigner(account.private_key)
    signed_payment_txn = TransactionWithSigner(
        unsigned_payment_txn,
        signer
    )
    composer.add_method_call(
        app_id=gora_contract_id,
        method=get_method_by_name(
                get_methods_list(GORACLE_ABI), "deposit_algo"
            ),
        sender=account.address,
        sp=algod_client.suggested_params(),
        signer=signer,
        method_args=[ signed_payment_txn, request_contract_address ]
    )
    composer.execute(algod_client, 4)
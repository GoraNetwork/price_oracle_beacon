from pyteal import Seq,InnerTxnBuilder,TxnField,Assert,abi,TxnType,Global

def send_algo(receiver, amount):
    return Seq([
        InnerTxnBuilder.Begin(),
        InnerTxnBuilder.SetFields({
            TxnField.type_enum: TxnType.Payment,
            TxnField.receiver: receiver,
            TxnField.amount: amount,
            # TxnField.fee: fee_amount
        }),
        InnerTxnBuilder.Submit()
    ])

def verify_algo_xfer(amount:abi.Uint64,algo_xfer:abi.PaymentTransaction):
    return Assert(
        algo_xfer.get().amount() >= amount.get(),
        algo_xfer.get().type_enum() == TxnType.Payment,
        algo_xfer.get().receiver() == Global.current_application_address(),
        algo_xfer.get().close_remainder_to() == Global.zero_address(),
        algo_xfer.get().rekey_to() == Global.zero_address(),
        algo_xfer.get().lease() == Global.zero_address()
    )


# TODO: do I need to make a withdraw gora function?

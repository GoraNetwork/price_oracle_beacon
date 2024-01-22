from pyteal import *

def clear_state_program():
    return Approve()

if __name__ == "__main__":
    print(compileTeal(
        Pragma(
            clear_state_program(),
            compiler_version="0.23.0"
        ),
        Mode.Application,
        version = 8
    ))
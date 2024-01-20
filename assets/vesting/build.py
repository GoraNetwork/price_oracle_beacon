from vesting import Vesting
from beaker import *
import argparse
from pyteal import *

parser = argparse.ArgumentParser()
#parser.add_argument('-t', '--token', required=False)
#parser.add_argument('-l', '--lock', required=False)
args = parser.parse_args()

TEAL_VERSION = 8
Pragma(
    Vesting(TEAL_VERSION).dump("./assets/vesting/artifacts", client=sandbox.get_algod_client()),
    compiler_version="0.23.0"
)

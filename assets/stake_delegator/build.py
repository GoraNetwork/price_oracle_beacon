
from test.MockMain import MockMain
from beaker import *
from pyteal import *

from stake_delegator import StakeDelegator

TEAL_VERSION = 8
Pragma(
    StakeDelegator(version=TEAL_VERSION).dump("./assets/stake_delegator/artifacts", client=sandbox.get_algod_client()),
    compiler_version="0.23.0"
)
MockMain(TEAL_VERSION).dump("./assets/stake_delegator/artifacts/mock_main", client=sandbox.get_algod_client())

# Build the sample contract in this directory using Beaker and output to ./artifacts
from pathlib import Path
from algosdk import logic
from beaker import *
import price_pair
from pyteal import *


def build(DEMO_MODE=True) -> Path:
    """Build the beaker app, export it to disk, and return the Path to the app spec file"""
    PricePair = price_pair.PricePair

    output_dir = Path(__file__).parent / "artifacts"
    if DEMO_MODE:
        PricePair.build(localnet.get_algod_client()).export(output_dir)
    else:
        PricePair.build().export(output_dir)

    print(f"Dumping {PricePair.name} to {output_dir}")
    
    return output_dir / "application.json"


if __name__ == '__main__':
    build(False)   
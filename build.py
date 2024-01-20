# Build the sample contract in this directory using Beaker and output to ./artifacts
from pathlib import Path
from algosdk import logic
from beaker import *
import price_pair
from pyteal import *

def build() -> Path:
    """Build the beaker app, export it to disk, and return the Path to the app spec file"""
    app = price_pair.PricePair

    output_dir = Path(__file__).parent / "artifacts"
    app.build(localnet.get_algod_client()).export(output_dir)

    print(f"Dumping {app.name} to {output_dir}")
    
    return output_dir / "application.json"

   
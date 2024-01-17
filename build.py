# Build the sample contract in this directory using Beaker and output to ./artifacts
from pathlib import Path
from beaker import *
import price_pair
from pyteal import *

def build() -> Path:
    """Build the beaker app, export it to disk, and return the Path to the app spec file"""
    app = price_pair.app

    output_dir = Path(__file__).parent / "artifacts"
    app.build(sandbox.get_algod_client()).export(output_dir)

    print(f"Dumping {app.name} to {output_dir}")
    
    return output_dir / "application.json"


if __name__ == "__main__":
    build()
   
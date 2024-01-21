import os,sys
from pathlib import Path

ABI_PATH = str(Path(__file__).parent)
# "/" for linux "\" for windows
if "win" in str(sys.platform):
    system_delima = "\\"
else:
    system_delima = "/"


if "GORACLE_ABI_PATH" in os.environ:
    ABI_PATH = os.environ["GORACLE_ABI_PATH"]
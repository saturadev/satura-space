from typing import Annotated

from pydantic import Field

ProjectRoot = Annotated[str, Field(description=(
    "Leave empty for this project. A scratchpad's or a multiplayer player's folder targets that editor."
))]

Player = Annotated[str, Field(description=(
    "Which editor: primary, clones, all, a vpId or a 1-based player number."
))]

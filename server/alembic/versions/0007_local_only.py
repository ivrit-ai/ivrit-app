"""user settings: transcribe on the user's devices only (local_only)

Revision ID: 0007
Revises: 0006
Create Date: 2026-10-20

"""
from typing import Sequence, Union

from alembic import op
import sqlalchemy as sa


revision: str = "0007"
down_revision: Union[str, None] = "0006"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    # local_only: the user's audio is never transcribed here; their devices do it.
    op.add_column("user_settings", sa.Column("local_only", sa.Boolean(), nullable=True))


def downgrade() -> None:
    op.drop_column("user_settings", "local_only")

"""user settings: what each user chose, such as keeping short clips in Drive

Revision ID: 0006
Revises: 0005
Create Date: 2026-10-08

"""
from typing import Sequence, Union

from alembic import op
import sqlalchemy as sa


revision: str = "0006"
down_revision: Union[str, None] = "0005"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    # clips_to_drive: null until the user is asked, then their answer.
    op.create_table(
        "user_settings",
        sa.Column("user_email", sa.Text(), primary_key=True),
        sa.Column("clips_to_drive", sa.Boolean(), nullable=True),
        sa.Column("updated_at", sa.BigInteger(), nullable=False),
    )


def downgrade() -> None:
    op.drop_table("user_settings")

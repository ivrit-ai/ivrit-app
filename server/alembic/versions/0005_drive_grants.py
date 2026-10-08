"""drive grants: each user's Drive access, kept for work that outlives a request

Revision ID: 0005
Revises: 0004
Create Date: 2026-10-08

"""
from typing import Sequence, Union

from alembic import op
import sqlalchemy as sa


revision: str = "0005"
down_revision: Union[str, None] = "0004"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    # A transcription can finish after the server that queued it has restarted, when
    # no request carries the user's session cookie: its Google refresh token is kept
    # here, encrypted with the session key, to save the result to their Drive.
    op.create_table(
        "drive_grants",
        sa.Column("user_email", sa.Text(), primary_key=True),
        sa.Column("refresh_token", sa.Text(), nullable=False),
        sa.Column("updated_at", sa.BigInteger(), nullable=False),
    )


def downgrade() -> None:
    op.drop_table("drive_grants")

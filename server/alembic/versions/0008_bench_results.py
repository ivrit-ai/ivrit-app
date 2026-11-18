"""the on-device benchmark's results (bench.py)

Revision ID: 0008
Revises: 0007
Create Date: 2026-11-18

"""
from typing import Sequence, Union

from alembic import op
import sqlalchemy as sa


revision: str = "0008"
down_revision: Union[str, None] = "0007"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    # One row a run: what the leaderboard sorts and groups by in columns, the rest
    # (stages, settings, versions) in body as the phone sent it, scored here.
    op.create_table(
        "bench_results",
        sa.Column("id", sa.Text(), primary_key=True),
        sa.Column("created_at", sa.BigInteger(), nullable=False),
        sa.Column("benchmark", sa.Text(), nullable=False),
        sa.Column("device", sa.Text(), nullable=False),
        sa.Column("engine", sa.Text(), nullable=False),
        sa.Column("app", sa.Text(), nullable=False),
        sa.Column("seconds", sa.Float(), nullable=False),
        sa.Column("wer", sa.Float(), nullable=True),
        # Google Play vouched for the app and the phone that sent it (Play Integrity).
        sa.Column("verified", sa.Boolean(), nullable=False, server_default=sa.false()),
        sa.Column("body", sa.Text(), nullable=False),
    )
    op.create_index("bench_results_board", "bench_results", ["benchmark", "device", "seconds"])


def downgrade() -> None:
    op.drop_index("bench_results_board", table_name="bench_results")
    op.drop_table("bench_results")

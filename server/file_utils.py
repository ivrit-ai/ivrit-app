"""File storage abstraction layer for transcription service.

This module defines the interface that both Google Drive and local filesystem
backends must implement.

Folders: the backend keeps one top folder per user (ensure_folder), and the
folders the app makes under it, at any depth. A method that takes `folder`
works in that folder (an id from list_folders or create_folder), or in the top
folder when it is None. File and folder ids are the backend's own (Drive ids,
or paths on disk).
"""

from abc import ABC, abstractmethod
from typing import Optional, Dict, Any, List, Tuple

# A Google Doc: what an HTML upload is converted into (upload_file's convert_to).
GOOGLE_DOC = "application/vnd.google-apps.document"


class FileStorageBackend(ABC):
    """Abstract base class for file storage backends."""
    
    @abstractmethod
    async def ensure_folder(self, user_identifier: Optional[str] = None) -> Optional[str]:
        """Ensure the storage folder exists and return its identifier."""
        pass
    
    @abstractmethod
    async def get_available_storage_bytes(self, user_identifier: Optional[str]) -> Optional[int]:
        """Return the free space left in the user's storage, or None if unknown."""
        pass

    @abstractmethod
    async def upload_file(
        self,
        filename: str,
        file_data: bytes,
        mime_type: str,
        user_identifier: Optional[str] = None,
        user_email: Optional[str] = None,
        folder: Optional[str] = None,
        convert_to: Optional[str] = None,
    ) -> Optional[str]:
        """Upload a file to storage (into `folder`); returns its id, or a false value.
        convert_to=GOOGLE_DOC turns an HTML upload into a Google Doc where the
        backend can (local storage keeps the HTML)."""
        pass
    
    @abstractmethod
    async def update_file(
        self,
        file_id: str,
        file_data: bytes,
        mime_type: str,
        user_identifier: Optional[str] = None,
        user_email: Optional[str] = None
    ) -> bool:
        """Update an existing file in storage."""
        pass
    
    @abstractmethod
    async def download_file_bytes(
        self,
        file_id: str,
        user_identifier: Optional[str] = None
    ) -> Optional[bytes]:
        """Download a file as raw bytes."""
        pass
    
    @abstractmethod
    async def find_file_by_name(
        self,
        filename: str,
        user_identifier: Optional[str] = None,
        folder: Optional[str] = None,
    ) -> Optional[str]:
        """Find a file by name (in `folder`) and return its identifier."""
        pass
    
    @abstractmethod
    async def delete_file(
        self,
        file_id: str,
        user_identifier: Optional[str] = None,
        user_email: Optional[str] = None
    ) -> bool:
        """Delete a file from storage."""
        pass
    
    @abstractmethod
    async def get_file_metadata(
        self,
        file_id: str,
        user_identifier: Optional[str] = None
    ) -> Optional[Dict[str, Any]]:
        """Get metadata for a file, including size."""
        pass
    
    @abstractmethod
    async def stream_file_range(
        self,
        file_id: str,
        range_header: Optional[str] = None,
        user_identifier: Optional[str] = None
    ) -> Optional[Tuple[bytes, int, int, int, int]]:
        """
        Stream a file with optional range support.
        Returns tuple of (content, status_code, start_byte, end_byte, total_size) or None.
        """
        pass

    @abstractmethod
    async def list_folders(self, user_identifier: Optional[str] = None) -> List[Dict[str, Any]]:
        """Every folder under the top folder, at any depth: [{id, name, parent}],
        parent being the top folder's id for those directly under it."""
        pass

    @abstractmethod
    async def create_folder(self, name: str, parent: str, user_identifier: Optional[str] = None) -> Optional[str]:
        """Make a folder named `name` in `parent`; returns its id."""
        pass

    @abstractmethod
    async def rename_item(self, item_id: str, name: str, user_identifier: Optional[str] = None) -> Optional[str]:
        """Rename a file or folder; returns its id afterwards (unchanged in Drive)."""
        pass

    @abstractmethod
    async def move_item(
        self, item_id: str, from_folder: str, to_folder: str, user_identifier: Optional[str] = None
    ) -> Optional[str]:
        """Move a file or folder from one folder to another; returns its id afterwards."""
        pass

    @abstractmethod
    async def trash_item(self, item_id: str, user_identifier: Optional[str] = None) -> bool:
        """Move a file or folder, with everything in it, to the trash (Drive keeps it 30 days)."""
        pass

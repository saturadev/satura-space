def _hold_pyz_in_memory():
    import marshal
    import zlib

    import pyimod02_importers

    archive = pyimod02_importers.pyz_archive
    if archive is None or not archive.toc:
        return
    end = max(offset + length for _, offset, length in archive.toc.values())
    with open(archive._filename, "rb") as fp:
        fp.seek(archive._start_offset)
        blob = fp.read(end)
    if len(blob) != end:
        return

    def extract(name, raw=False):
        entry = archive.toc.get(name)
        if entry is None:
            raise KeyError(f"No entry named {name!r} found in the archive!")
        typecode, offset, length = entry
        if typecode == 3:
            return None
        data = zlib.decompress(blob[offset:offset + length])
        if typecode in (0, 1) and not raw:
            try:
                return marshal.loads(data)
            except EOFError as e:
                raise ImportError(f"Failed to unmarshal PYZ entry {name!r}!") from e
        return data

    archive.extract = extract


_hold_pyz_in_memory()
del _hold_pyz_in_memory

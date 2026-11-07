import re

_READ_CALLS = frozenset("""
Print Log LogWarning LogError LogFormat LogWarningFormat LogErrorFormat
ToString Equals GetHashCode GetType Format Join Concat Substring Replace Split Trim TrimStart TrimEnd
ToLower ToUpper ToLowerInvariant ToUpperInvariant Contains ContainsKey ContainsValue StartsWith EndsWith
IndexOf LastIndexOf PadLeft PadRight IsNullOrEmpty IsNullOrWhiteSpace Parse CompareTo Compare
Min Max Abs Round RoundToInt FloorToInt CeilToInt Floor Ceil Sqrt Pow Clamp Clamp01 Lerp InverseLerp
Approximately Sign Distance Dot Cross Angle SignedAngle Magnitude SqrMagnitude Project ProjectOnPlane
Euler Inverse LookRotation
Find FindWithTag FindGameObjectWithTag FindGameObjectsWithTag FindObjectOfType FindObjectsOfType
FindObjectsByType FindFirstObjectByType FindAnyObjectByType
GetComponent GetComponents GetComponentInChildren GetComponentsInChildren GetComponentInParent
GetComponentsInParent CompareTag GetChild GetSiblingIndex IsChildOf TransformPoint InverseTransformPoint
TransformDirection InverseTransformDirection TransformVector InverseTransformVector
GetActiveScene GetSceneAt GetSceneByName GetSceneByPath GetSceneByBuildIndex GetRootGameObjects
LoadAssetAtPath LoadAllAssetsAtPath LoadMainAssetAtPath FindAssets GUIDToAssetPath AssetPathToGUID
GetAssetPath GetDependencies IsValidFolder GetSubFolders GetMainAssetTypeAtPath GetLabels
GetPrefabAssetType GetPrefabInstanceStatus GetCorrespondingObjectFromSource
GetPrefabAssetPathOfNearestInstanceRoot GetNearestPrefabInstanceRoot GetOutermostPrefabInstanceRoot
IsPartOfPrefabInstance IsPartOfPrefabAsset IsAnyPrefabInstanceRoot GetDirtyCount IsDirty IsPersistent
GetInstanceID GetEntityId
Select SelectMany Where OrderBy OrderByDescending ThenBy ThenByDescending GroupBy Count LongCount Any All
First FirstOrDefault Last LastOrDefault Single SingleOrDefault Take TakeWhile Skip SkipWhile Distinct
ToArray ToList ToDictionary ToHashSet ToLookup Sum Average Aggregate Cast OfType Zip ElementAt
ElementAtOrDefault Range Repeat Empty Concat Union Intersect Except SequenceEqual DefaultIfEmpty
Exists ReadAllText ReadAllLines GetFiles GetDirectories GetFileName GetFileNameWithoutExtension
GetExtension GetDirectoryName GetFullPath Combine GetLastWriteTimeUtc
GetProperty GetProperties GetField GetFields GetMethod GetMethods GetValue GetCustomAttributes IsDefined
HasValue GetValueOrDefault
""".split())

_QUALIFIED_READS = {
    "SaturaHandles": frozenset("List Result".split()),
    "SaturaClips": frozenset("List Describe Get Muscles PathOf Key KeyAt Muscle".split()),
}

_LOCAL_CALLS = frozenset("""
Add AddRange Append AppendLine AppendFormat Insert Remove RemoveAt RemoveAll Clear Sort Reverse
TryAdd Push Pop Enqueue Dequeue Peek
""".split())

_NEW_OK = frozenset("""
StringBuilder List Dictionary HashSet SortedDictionary SortedSet Queue Stack
Vector2 Vector3 Vector4 Vector2Int Vector3Int Quaternion Color Color32 Rect RectInt Bounds BoundsInt Ray
Plane Matrix4x4 TimeSpan DateTime Regex Random object string int float double long bool byte char
""".split())

_LOCAL_COLLECTIONS = frozenset("StringBuilder List Dictionary HashSet SortedDictionary SortedSet Queue Stack".split())

_KEYWORDS = frozenset("""
if for foreach while switch catch typeof nameof sizeof default return lock using when and or not is as
in else do try finally break continue throw case var checked unchecked
""".split())

_DENY_WORDS = frozenset("ref out unsafe fixed stackalloc delegate goto yield await async".split())

_DENY_MEMBERS = frozenset("material materials mesh".split())

_IDENT = re.compile(r"[A-Za-z_]\w*")


def _strip(code: str) -> str | None:
    out = []
    i, n = 0, len(code)
    while i < n:
        ch = code[i]
        if code.startswith("//", i):
            j = code.find("\n", i)
            i = n if j < 0 else j
            continue
        if code.startswith("/*", i):
            j = code.find("*/", i + 2)
            if j < 0:
                return None
            i = j + 2
            out.append(" ")
            continue
        if ch == "$" or ch == "@" or ch == '"' or ch == "'":
            m = re.match(r'(\$@|@\$|\$|@)?(")', code[i:])
            if ch == "'":
                j = i + 1
                while j < n and code[j] != "'":
                    j += 2 if code[j] == "\\" else 1
                if j >= n:
                    return None
                out.append("'c'")
                i = j + 1
                continue
            if not m:
                out.append(ch)
                i += 1
                continue
            prefix = m.group(1) or ""
            if '"""' == code[i + len(prefix):i + len(prefix) + 3]:
                return None
            verbatim = "@" in prefix
            interp = "$" in prefix
            j = i + len(prefix) + 1
            parts = []
            while True:
                if j >= n:
                    return None
                c = code[j]
                if verbatim and c == '"' and code[j + 1:j + 2] == '"':
                    j += 2
                    continue
                if not verbatim and c == "\\":
                    j += 2
                    continue
                if c == '"':
                    j += 1
                    break
                if interp and c == "{":
                    if code[j + 1:j + 2] == "{":
                        j += 2
                        continue
                    depth, k = 1, j + 1
                    while k < n and depth:
                        if code[k] == "{":
                            depth += 1
                        elif code[k] == "}":
                            depth -= 1
                        elif code[k] in "\"'":
                            return None
                        k += 1
                    if depth:
                        return None
                    parts.append("(" + code[j + 1:k - 1].split(":")[0] + ")")
                    j = k
                    continue
                j += 1
            out.append('"s"' + "".join(" + " + p for p in parts))
            i = j
            continue
        out.append(ch)
        i += 1
    return "".join(out)


def _lhs_is_local(text: str, op_at: int) -> bool:
    k = op_at
    while k > 0 and text[k - 1].isspace():
        k -= 1
    start = k
    while start > 0 and (text[start - 1].isalnum() or text[start - 1] in "_.[]<>?"):
        start -= 1
    lhs = text[start:k]
    if not lhs or "." in lhs or "[" in lhs or "]" in lhs:
        return False
    return _IDENT.fullmatch(lhs) is not None


def snippet_is_read_only(code: str) -> bool:
    text = _strip(code)
    if text is None:
        return False
    for w in _IDENT.findall(text):
        if w in _DENY_WORDS:
            return False
    for m in re.finditer(r"\+\+|--", text):
        if _lhs_is_local(text, m.start()):
            continue
        right = re.match(r"\s*([A-Za-z_]\w*)(\s*[.\[(])?", text[m.end():])
        if right and not right.group(2):
            continue
        return False
    if re.search(r"\.\s*(" + "|".join(_DENY_MEMBERS) + r")\b(?!\s*\()", text):
        return False
    locals_ok = set()
    for m in re.finditer(r"\bnew\s+([A-Za-z_][\w.]*)?\s*(<[^;{}()]*>)?\s*([\[({])", text):
        name = (m.group(1) or "").rsplit(".", 1)[-1]
        if name and name not in _NEW_OK:
            return False
        if not name and m.group(3) == "(":
            return False
    for m in re.finditer(r"\bnew\b(?!\s*([A-Za-z_][\w.]*\s*(<[^;{}()]*>)?\s*)?[\[({])", text):
        return False
    for m in re.finditer(
        r"(?:\bvar|\b(?:" + "|".join(_LOCAL_COLLECTIONS) + r")\s*(?:<[^;{}()]*>)?)\s+([A-Za-z_]\w*)\s*=\s*new\s+(?:"
        + "|".join(_LOCAL_COLLECTIONS) + r")\b", text):
        locals_ok.add(m.group(1))
    for m in re.finditer(r"(?<![=!<>+\-*/%&|^?])(?:[+\-*/%&|^]|<<|>>|\?\?)?=(?![=>])", text):
        if not _lhs_is_local(text, m.start()):
            return False
    for m in re.finditer(r"([A-Za-z_]\w*)\s*(?:<[^;{}()=]*>)?\s*\(", text):
        name = m.group(1)
        if name in _KEYWORDS:
            continue
        before = text[:m.start()].rstrip()
        if before.endswith("new") and re.search(r"\bnew$", before):
            continue
        if name in _READ_CALLS or name == "PathOf" and not before.endswith("."):
            continue
        owner = re.search(r"\b([A-Za-z_]\w*)\s*\.$", before)
        if owner and name in _QUALIFIED_READS.get(owner.group(1), ()):
            continue
        if name in _LOCAL_CALLS and before.endswith("."):
            recv = re.search(r"([A-Za-z_]\w*)\s*\.$", before)
            if recv and recv.group(1) in locals_ok and not re.search(r"\.\s*" + recv.group(1) + r"\s*\.$", before):
                continue
        return False
    return True

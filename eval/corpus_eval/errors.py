"""Error types. Every input problem is refused loudly: a measurement that skips a
row it could not read would report a rate over a population nobody chose."""


class EvalError(Exception):
    """Base of every refusal this package raises."""


class ManifestError(EvalError):
    """The manifest is malformed, or cannot support a two-population measurement."""


class ScoresError(EvalError):
    """The check's scores do not cover exactly the manifest's items."""


class CeilingError(EvalError):
    """The ceiling is absent or out of range; no operating point is chosen without one."""

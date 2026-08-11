"""Railway-domain libraries shared by scripts in app/scripts/railway/.

The CLI entry points and this package share one domain directory. Running a
CLI puts app/scripts/railway/ on sys.path[0], so Python consumers can
import as `from lib import railpkg`.
"""

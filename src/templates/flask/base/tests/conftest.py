import pytest
from src.app import create_app


@pytest.fixture()
def app():
    app = create_app()
    app.config.from_object("src.app.config.TestingConfig")
    yield app


@pytest.fixture()
def client(app):
    return app.test_client()

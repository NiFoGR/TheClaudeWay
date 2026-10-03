from aetos_leads import owner


def site(texts, htmls=()):
    found = owner.from_website(texts, htmls)
    return found[:2] if found else None


def test_website_self_introductions_and_owner_labels():
    assert site(["Hi, I'm Dave Smith and I've been roofing in Leeds for 20 years."]) == ("Dave", "Dave Smith")
    assert site(["Meet Sarah, our founder."]) == ("Sarah", "Sarah")
    assert site(["Meet Dave Our Founder"]) == ("Dave", "Dave")
    assert site(["Family business run by Gareth Jones since 1998"]) == ("Gareth", "Gareth Jones")
    assert site(["Owner: Kevin Hughes"]) == ("Kevin", "Kevin Hughes")
    assert site(["Paul Evans - Director"]) == ("Paul", "Paul Evans")
    html = '<script type="application/ld+json">{"@type":"RoofingContractor","founder":{"@type":"Person","name":"Liam Carter"}}</script>'
    assert site([], [html]) == ("Liam", "Liam Carter")


def test_website_ignores_words_that_arent_names():
    assert site(["Meet the team behind Smith Roofing", "I'm proud of our work", "Owner operated since 2001"]) is None



def test_names_are_recognised_without_a_list():
    # names outside any list, and everyday words that are also names, are read from the sentence
    assert site(["Owner: Grant Wilkinson, 20 years in the trade"]) == ("Grant", "Grant Wilkinson")
    assert site(["Family-run business founded by Rajesh Patel in 2004."]) == ("Rajesh", "Rajesh Patel")
    reviews = [{"author": "A B", "text": "Huge thanks to Kasia for sorting our boiler."},
               {"author": "C D", "text": "Kasia was quick and tidy, highly recommend."}]
    assert owner.from_reviews(reviews) == ("Kasia", "Kasia")
    assert owner.from_email(["info@smith.co.uk", "enquiries@smith.co.uk", "sales@smith.co.uk"], "smith.co.uk") is None


def test_reviews_need_two_different_customers_naming_the_same_person():
    reviews = [
        {"author": "Jane Doe", "text": "Dave was brilliant, fixed the roof in a day."},
        {"author": "Tom Hill", "text": "Great job by Dave and the lads. Recommended."},
        {"author": "Amy Lee", "text": "Very tidy work."},
    ]
    assert owner.from_reviews(reviews) == ("Dave", "Dave")
    assert owner.from_reviews(reviews[:1]) is None
    # the reviewer's own name doesn't count
    assert owner.from_reviews([{"author": "Tom Hill", "text": "Tom here, great"}, {"author": "Tom Hill", "text": "Tom again"}]) is None


def test_email_and_business_name():
    assert owner.from_email(["info@smith.co.uk", "dave.smith@smith.co.uk"], "smith.co.uk") == ("Dave", "Dave Smith")
    assert owner.from_email(["dave@gmail.com"], "smith.co.uk") is None  # not their own domain
    assert owner.from_email(["info@smith.co.uk"], "smith.co.uk") is None
    assert owner.from_business_name("Dave's Plumbing & Heating") == ("Dave", "Dave")
    assert owner.from_business_name("Steve Brown Roofing Ltd") == ("Steve", "Steve Brown")
    assert owner.from_business_name("Apex Roofing") is None


def test_most_trusted_source_wins():
    page = "<html><body><p>Hi, I'm Rachel, I run the business.</p></body></html>"
    found = owner.find_owner([page], ["dave@smith.co.uk"], "smith.co.uk", "Steve's Roofing", [])
    assert found == {"first": "Rachel", "full": "Rachel", "source": "website", "confident": True}
    found = owner.find_owner([], ["dave@smith.co.uk"], "smith.co.uk", "Steve's Roofing", [])
    assert found["source"] == "email" and found["first"] == "Dave"
    assert owner.find_owner([], [], "", "Apex Roofing", [])["first"] == ""


def test_never_the_business_town_or_a_famous_name():
    # real data, kickboxing in Warrington: these were all shown as "Owner"
    towns = ["Warrington"]
    for business, page, reviews in [
        ("Diamond Kickboxing Academy", "", []),
        ("Gracie Barra Warrington Brazilian Jiujitsu and Self Defence", "Gracie Barra Warrington welcomes you. Gracie Barra is a team.", []),
        ("Ground Nation", "BJJ Warrington classes for all. Owner operated. Bjj Warrington is the home of champions.", []),
        ("The Forge Fight Academy Warrington", "The Forge is run by our team. Forge members love it.", []),
        ("Warrington Thai Boxing", "", [{"author": "A", "text": "Great Thai classes"}, {"author": "B", "text": "Thai boxing done right"}]),
        ("Warrington Martial Arts Studio", "Train like Bruce Lee. Our style was founded by Bruce Lee.", []),
    ]:
        found = owner.find_owner([f"<p>{page}</p>"] if page else [], [], "", business, reviews, towns)
        assert found["first"] == "", (business, found)


def test_facebook_bio_led_by():
    bio = ("Diamond Kickboxing is Warringtons premier kickboxing & Muay Thai Academy led by Mark Matthews We are "
           "passionate about helping members from beginners to experts meet their goals")
    found = owner.find_owner([f"<p>{bio}</p>"], [], "", "Diamond Kickboxing Academy", [], ["Warrington"])
    assert (found["full"], found["confident"]) == ("Mark Matthews", True)


def test_guesses_are_marked_unconfirmed():
    reviews = [{"author": "A", "text": "Kasia was brilliant"}, {"author": "B", "text": "Thanks Kasia!"}]
    assert owner.find_owner([], [], "", "Apex Roofing", reviews)["confident"] is False
    assert owner.find_owner([], [], "", "Dave's Plumbing", [])["confident"] is False

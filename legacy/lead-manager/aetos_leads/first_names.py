"""Common UK first names, to tell a person's name from an ordinary word ("Dave was great" vs "Roof was great").

Words that are also everyday English when capitalised (Will, Mark, Grant, Bill, Rose, Dawn, May…) are left out on purpose:
a missed name is fine, a wrong one in "Hi Grant," is not.
"""

_NAMES = """
aaron abdul abigail adam adrian aidan aimee alan alana albert alec alex alexander alexandra alfie alfred ali alice alicia
alison amanda amber amelia amir amy andrea andrew andy angela angus anna anne annie anthony anton archie arthur ashley
barbara barry ben benjamin bernard beth bethany bob bobby brad bradley brandon brendan brett brian bruce bryan callum
calum cameron carl carla carlos carol caroline carys catherine charlie charles charlotte chloe chris christian christina
christine christopher ciaran claire clare colin connor conor craig daisy damian damien dan daniel danielle danny darren
dave david davie dean debbie deborah declan dennis derek dominic donald donna doug douglas duncan dylan ed eddie edward
eileen elaine eleanor elizabeth ella ellie elliot elliott emily emma eric erin ethan eugene evan ewan fiona frank
frankie fraser freddie frederick gareth garry gary gavin gemma geoff geoffrey george georgia gerald gerry gethin gillian
gordon graeme graham greg gregor gregory hamish hannah harriet harry harvey hayden heather helen henry holly hugh hugo
iain ian imran isaac isabel isabella isla ivan jack jackie jacob jade jake james jamie jan jane janet jason jay jayden
jean jeff jeffrey jenna jennifer jenny jeremy jess jessica jim jimmy joanna joanne jodie joe joel john johnny jon
jonathan jordan joseph josh joshua julia julian julie justin karen karl kate katherine kathryn katie kayleigh keith
kelly ken kenneth kerry kevin kieran kim kirsty kyle lee leigh leo leon lewis liam lisa lloyd logan louis louise lucas
lucy luke lyndon mandy marc marcus maria marie martin martyn mary matt matthew max megan melissa michael michelle mick
mike miles mohammed molly muhammad nathan neil nicholas nick nicola nicole niall nigel noah norman oliver olivia oscar
owen paddy paige pamela patrick paul paula pete peter phil philip phillip rachel rhys richard ricky rob robbie robert
robin rory ross ruth ryan sally sam samantha samuel sandra sara sarah scott sean seb sebastian shane shannon sharon
shaun sian simon sophie stacey stephen steph stephanie steve steven stewart stuart susan suzanne tara teresa terry
thomas tim timothy toby tom tommy tony tracey tracy trevor tyler vicky victoria vince vincent wayne wendy william zach
zoe
"""

FIRST_NAMES = frozenset(_NAMES.split())


def is_first_name(word: str) -> bool:
    return word.strip(".,'’!?:;()").lower() in FIRST_NAMES
